/* Review Notes panel. Runs inside the webview; talks to the extension via postMessage.
 * State arrives in two independent messages so slow/failing session lookups can never
 * stop the notes from rendering:
 *   { type: 'notes',   cards, sent, kinds } — cheap, always sent first
 *   { type: 'session', session: … } — best-effort, may never arrive
 */
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  /** @type {{cards: any[], sent: any[], kinds: any[], session: any}} */
  let state = { cards: [], sent: [], kinds: [], session: null };

  /*
   * Cards whose code is unfolded, and settled cards whose exchange is open.
   *
   * Held here rather than as a class on the element: the panel repaints by replacing its
   * markup, so anything written on a node is gone the next time the note changes — which,
   * while an agent is working, is constantly. Both of these used to be a `classList.toggle`
   * and both folded themselves back up mid-read.
   */
  const unclipped = new Set();
  const unfolded = new Set();
  let ready = false;
  let pendingRender = false;
  /** The card the user last interacted with — the fallback target for ⌘V. */
  let lastCardId;
  /** True while a file drag is over the panel; blocks re-renders (see the drag section). */
  let dragging = false;

  /** `<span class="codicon codicon-bug">` — the same icon set the editor widget uses. */
  const icon = (name) => '<span class="codicon codicon-' + esc(name) + '"></span>';

  const esc = (s) =>
    String(s === undefined || s === null ? '' : s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );

  const post = (msg) => vscode.postMessage(msg);

  // A thrown handler used to disable a feature silently (drag & drop especially). Report
  // everything to the extension log instead.
  window.addEventListener('error', (e) => {
    post({ type: 'panelError', text: `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}` });
  });
  window.addEventListener('unhandledrejection', (e) => {
    post({ type: 'panelError', text: `unhandled rejection: ${String(e.reason)}` });
  });

  /** Wrap a listener so a throw is reported and cannot break later events. */
  const guard = (name, fn) => (e) => {
    try {
      return fn(e);
    } catch (err) {
      post({ type: 'panelError', text: `${name}: ${String(err && err.stack ? err.stack : err)}` });
      return undefined;
    }
  };
  const cmd = (command, id) => post({ type: 'command', command, id });

  /**
   * Show a spinner on the button that was just clicked.
   *
   * Applied here rather than waiting for the extension to say so: finding the Claude
   * session shells out to `ps` and the Orca CLI, which takes a second or two, and until
   * something moves the panel looks frozen. Cleared when fresh state arrives, with a
   * timeout so a command that never reports back cannot leave a button spinning forever.
   */
  let busyEl;
  let busyTimer = 0;

  function clearBusy() {
    if (busyTimer) {
      clearTimeout(busyTimer);
      busyTimer = 0;
    }
    if (busyEl) {
      busyEl.classList.remove('busy');
      const scope = busyEl.closest('.actions') || busyEl.closest('.controls');
      if (scope) scope.classList.remove('running');
      const host = busyEl.closest('.session') || busyEl.closest('.card');
      if (host) host.classList.remove('busy');
      busyEl = undefined;
    }
  }

  const BUSY_TIMEOUT_MS = 20000;

  function markBusy(el) {
    // Buttons only — including the things acting as one: `.body` also carries a `data-act`,
    // and marking it would say a note was running when nothing is.
    if (!el) return;
    const isButton = el.tagName === 'BUTTON' || (el.getAttribute && el.getAttribute('role') === 'button');
    if (!isButton) return;
    clearBusy();
    busyEl = el;
    el.classList.add('busy');
    /*
     * Dim the neighbours so a second click on a different action is obviously not wanted.
     *
     * Not `working`: that is also the class on a card's status row, which carries a dark
     * padded box of its own — so marking a row of controls with it drew that box around them.
     * The session switcher looked like it grew a background and the card grew with it, which
     * is the padding on a status row, applied to a row of icons.
     */
    const scope = el.closest('.actions') || el.closest('.controls');
    if (scope) scope.classList.add('running');
    // The whole card says it is working — a spinner swapped in for a label changes the
    // button's width, which changes the row's height, which moves everything under it.
    const host = el.closest('.session') || el.closest('.card');
    if (host) host.classList.add('busy');
    busyTimer = setTimeout(clearBusy, BUSY_TIMEOUT_MS);
  }

  /**
   * Re-rendering replaces the DOM wholesale.
   *
   * A drag has to wait: the element under the pointer would be swapped out mid-gesture and the
   * drop would land nowhere. Typing does not — `paint` carries the box and the caret across,
   * so a turn appears the moment it is written instead of waiting for you to click away.
   */
  function isBusy() {
    return dragging;
  }

  function findNote(id) {
    for (const n of state.cards || []) if (n.id === id) return n;
    for (const n of state.sent) if (n.id === id) return n;
    return {};
  }

  // ── rendering ────────────────────────────────────────────────────────

  /**
   * A note Claude has finished with, that nobody has agreed with yet.
   *
   * Any outcome counts — done, skipped, or a question answered without touching the code. It
   * used to require a change, so Claude replying "I left it alone, say what you want" landed
   * on none of the branches and the card said *Waiting for Claude…* about a conversation that
   * was waiting on the reader. A change with no outcome yet counts too: the code moved.
   */
  function awaitingApproval(n) {
    return !!n.sent && !n.done && !n.pendingReply && (!!n.sent.outcome || !!n.sent.changed);
  }

  /** Strip the common leading indentation so code previews hug the left edge. */
  function dedent(text) {
    const lines = String(text).split('\n');
    let min = Infinity;
    for (const l of lines) {
      if (!l.trim()) continue;
      const m = l.match(/^[ \t]*/);
      min = Math.min(min, m ? m[0].length : 0);
    }
    if (!isFinite(min) || min === 0) return text;
    return lines.map((l) => l.slice(min)).join('\n');
  }

  const AGENT_PREFIX = 'Claude:';

  /*
   * What actually commits a follow-up. The box said ⏎, and ⏎ inserts a newline — so the first
   * thing a new reader tries does the one thing they did not ask for, and the words sit there
   * looking sent. A follow-up is often several lines, so ⏎ has to stay a newline.
   */
  const SEND_KEY = /mac|iphone|ipad/i.test((window.navigator && window.navigator.platform) || '')
    ? '⌘⏎'
    : 'Ctrl+⏎';

  /** A turn written by the agent rather than by you. Mirrors `isAgentTurn` in the model. */
  function isAgentTurn(turn) {
    return String(turn || '').startsWith(AGENT_PREFIX);
  }

  /**
   * The small slice of markdown an agent actually writes in a sentence about its own work:
   * `[label](target)` and `` `code` ``.
   *
   * Rendered rather than escaped because the raw form is what made these unreadable — a link
   * showed its label *and* its whole path, and a repository path is long enough to push the
   * card sideways. Escaped first, so nothing here can inject markup; only the two shapes
   * below are turned back into elements.
   */
  function inlineMarkdown(text) {
    return esc(text)
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, target) =>
        '<a class="ref" data-open="' + target + '" title="' + target + '">' + label + '</a>',
      )
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }

  /** One footer button. Keeps the action row readable instead of a chain of ternaries. */
  const btn = (act, glyph, title, cls) =>
    '<button data-act="' +
    act +
    '"' +
    (cls ? ' class="' + cls + '"' : '') +
    ' title="' +
    esc(title) +
    '">' +
    glyph +
    '</button>';

  /**
   * Which of the four things a card is.
   *
   *   drafting — written, not sent. Nothing has happened to it yet.
   *   approve  — Claude changed something and nobody has agreed with it.
   *   rejected — you turned that change down; another attempt is owed.
   *   done     — settled, kept for the record.
   *
   * Anything else is waiting on Claude, which is the same card as drafting minus the button.
   */
  function cardState(n) {
    if (n.done) return 'done';
    if (n.rejected) return 'rejected';
    if (awaitingApproval(n)) return 'approve';
    if (!n.sent) return 'drafting';
    return 'waiting';
  }

  /**
   * The word at the top of a card.
   *
   * Two of these are about where the work is rather than what state it is in: a reply you have
   * written and not sent, and a batch that only reached your clipboard. "Sent" was printed over
   * both of them, which is the one thing neither is.
   */
  function stateWord(n, state) {
    if (n.pendingReply && state !== 'rejected') return 'Reply not sent';
    if (state === 'waiting' && n.sent && n.sent.route === 'clipboard') return 'On your clipboard';
    if (state === 'waiting' && n.sent && n.sent.route === 'staged') return 'Staged';
    return STATE_WORD[state] || '';
  }

  const STATE_WORD = {
    drafting: 'Drafting',
    waiting: 'Sent',
    approve: 'Needs approval',
    rejected: 'Rejected',
    done: 'Done',
  };

  /** The lines the note was written about, with their real numbers beside them. */
  /** How much of a long snippet a card shows before you ask for the rest. */
  const SNIPPET_PREVIEW_LINES = 3;

  /**
   * The lines the note was written about.
   *
   * A note on a whole function is a perfectly ordinary thing to write, and thirty lines of it
   * at the top of a card pushes everything that needs answering off the screen. Past three
   * lines it fades out, and the rest is one click away.
   *
   * Which cards are open is held in `unclipped` rather than on the element, because the panel
   * repaints by replacing its markup — a class on the `<pre>` would be lost the next time
   * anything about the note changed, folding the code back up while you were reading it.
   */
  function snippetBlock(n) {
    if (!n.snippet) return '';
    const lines = dedent(n.snippet).split('\n');
    // A trailing blank from the selection is not a line of code.
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    const first = n.firstLine || 1;
    const width = String(first + lines.length - 1).length;
    const rows = lines
      .map((line, i) => {
        const num = String(first + i).padStart(width, ' ');
        return '<span class="ln">' + esc(num) + '</span>' + esc(line);
      })
      .join('\n');
    const pre = '<pre class="snip" data-act="reveal" title="Open in the editor">' + rows + '</pre>';
    if (lines.length <= SNIPPET_PREVIEW_LINES) return pre;

    const open = unclipped.has(n.id);
    return (
      '<div class="snipwrap' + (open ? '' : ' clipped') + '">' +
      pre +
      '<button class="unclip" data-act="unclip" title="' +
      (open ? 'Show the first three lines' : 'Show all ' + lines.length + ' lines') +
      '">' +
      (open ? 'Show less' : 'Show all ' + lines.length + ' lines') +
      '</button>' +
      '</div>'
    );
  }

  /**
   * The exchange, in the order it happened.
   *
   * Every turn, not just the newest. A follow-up written after Claude answered went into the
   * store and appeared nowhere, so the card looked as though the words had been thrown away —
   * and reading back over the conversation is most of what a card is for once it has been
   * round more than once.
   */
  /** How many turns Claude has read. Anything at or past it is still yours to change. */
  function seenOf(n) {
    return n.sent && typeof n.sent.seenTurns === 'number' ? n.sent.seenTurns : (n.addenda || []).length;
  }

  function threadBlocks(n, dimClaude, settled) {
    const raw = n.addenda || [];
    // Each entry keeps the index it has in the store. A report can arrive as an outcome with
    // no turn behind it — that is still Claude speaking, but it is not in `addenda`, so it
    // carries no index and nothing may be said about removing it.
    const turns = raw.map((text, at) => ({ text, at }));
    if (!turns.some((t) => isAgentTurn(t.text)) && n.sent && n.sent.reply) {
      turns.unshift({ text: AGENT_PREFIX + ' ' + n.sent.reply, at: -1 });
    }
    const seen = seenOf(n);

    return turns
      .map((turn, i) => {
        const mine = !isAgentTurn(turn.text);
        const text = mine ? String(turn.text).trim() : String(turn.text).replace(AGENT_PREFIX, '').trim();
        if (!text) return '';
        const last = i === turns.length - 1;
        const unsent = mine && turn.at >= seen;
        const label = mine
          ? n.rejected && last
            ? 'You · rejected'
            : 'You · follow-up'
          : n.sent && n.sent.outcome === 'answered'
            ? "Claude's answer"
            : "Claude's change";
        const cls = mine ? (n.rejected && last ? 'reject' : 'follow') : 'claude' + (dimClaude ? ' dim' : '');
        return (
          '<div class="block ' + cls + '">' +
          '<span class="block-label">' +
          '<span class="who">' + label + (unsent ? '<span class="unsent">not sent yet</span>' : '') + '</span>' +
          (unsent
            ? '<button class="drop" data-act="undo-turn" data-turn="' + turn.at + '" title="Remove this follow-up">' +
              icon('close') +
              '</button>'
            : '') +
          '</span>' +
          '<div class="block-body">' + inlineMarkdown(text) + '</div>' +
          // Beside the words it was taken for, not at the foot of the card. Turn 0 is the
          // note's own, drawn above the thread — a block never claims it.
          shotsFor(n, settled, turn.at + 1) +
          '</div>'
        );
      })
      .join('');
  }

  /**
   * Screenshots on a card.
   *
   * A row each rather than a strip of thumbnails: the name is what you recognise it by after
   * the fact, and which turn it belongs to is worth saying — a picture attached to a follow-up
   * is evidence for that follow-up, not for the note.
   */
  function shotsFor(n, settled, turn) {
    const shots = (n.attachments || []).filter((a) => (a.turn || 0) === turn);
    if (shots.length === 0) return '';
    // A capture goes with the turn it was taken for: while that turn is still yours it can be
    // taken off, and once Claude has read it removing it would rewrite what was asked. The
    // note's own (turn 0) is its evidence, and goes with the note the first time it is sent.
    const removable = !settled && (turn === 0 ? !n.sent : turn > seenOf(n));
    return (
      '<div class="shots">' +
      shots
        .map(
          (a) =>
            '<div class="shot">' +
            '<img src="' + esc(a.src) + '" alt="' + esc(a.name) + '" data-shot="' + esc(a.path) + '" title="Open ' + esc(a.name) + '">' +
            '<span class="what"><span class="name">' + esc(a.name) + '</span>' +
            '<span class="cap">' + esc(a.caption || 'attached screenshot') + '</span></span>' +
            (removable
              ? '<button class="x" data-unshot="' + esc(a.path) + '" title="Remove screenshot">' + icon('close') + '</button>'
              : '') +
            '</div>',
        )
        .join('') +
      '</div>'
    );
  }

  /**
   * The ones taken for a follow-up nobody has written yet.
   *
   * A capture records how many turns preceded it. Until the follow-up it was taken for is
   * committed, that number is off the end of the thread — so those shots sit with the box
   * you are typing into, and move up beside the words the moment you send them.
   */
  function pendingShots(n, settled) {
    return shotsFor(n, settled, (n.addenda || []).length + 1);
  }

  function card(n) {
    const state = cardState(n);
    const meta =
      '<div class="meta">' +
      '<span class="state ' +
      (n.pendingReply && state !== 'rejected' ? 'unsent' : state === 'waiting' && n.sent && n.sent.route ? 'unsent' : state) +
      '">' +
      // No dot here: the kind is already carried by its own icon beside the file, in the same
      // colour, and two marks for one thing left the state word looking indented for nothing.
      esc(stateWord(n, state)) +
      '</span>' +
      '<span class="ref' + (n.missing ? ' gone' : n.orphaned ? ' stale' : '') + '"' +
      (n.missing
        ? ' title="This file has been deleted — the note is kept for the record"'
        : n.orphaned
          ? ' title="The code this note pointed at has moved; the line may be wrong"'
          : '') +
      '>' +
      '<button class="kind k-' + esc(n.kind) + '" data-act="kind" title="Change kind — ' + esc(n.kindLabel) + '" ' +
      'aria-label="Change kind, currently ' + esc(n.kindLabel) + '">' +
      icon(n.kindIcon) +
      '</button>' +
      esc(n.fileRef) +
      '<button class="more" data-act="more" title="More actions…">' + icon('kebab-vertical') + '</button>' +
      '</span>' +
      '</div>';

    // Settled: the snippet and one line of what it was about, and nothing else. Clicking it
    // opens the rest — the conversation is still there, it is just not worth the room.
    if (state === 'done') {
      // The whole thread is rendered and folded away rather than dropped: expanding it is a
      // class, not a round trip, and what was said is still worth reading back.
      return (
        '<div class="card done' + (unfolded.has(n.id) ? ' open' : '') + '" data-id="' + esc(n.id) + '" data-kind="' + esc(n.kind) + '" tabindex="0">' +
        '<div class="summary" data-act="expand" title="Read the whole exchange back">' +
        '<span class="state done">Done</span>' +
        '<span class="kind k-' + esc(n.kind) + '" title="' + esc(n.kindLabel) + '">' +
        icon(n.kindIcon) +
        '</span>' +
        '<span class="what">' + esc(firstLineOf(n.body)) + '</span>' +
        '<span class="ref">' + esc(n.fileRef) + '</span>' +
        '<button class="drop" data-act="remove" title="Remove this note">' + icon('close') + '</button>' +
        '</div>' +
        // Everything else, including the code it was about, is behind the click. A settled card
        // is a line in a list until someone wants to read it.
        '<div class="folded">' +
        snippetBlock(n) +
        '<div class="say" data-act="reveal" title="Open in the editor">' + esc(n.body) + '</div>' +
        shotsFor(n, true, 0) +
        threadBlocks(n, false, true) +
        // Approving is not the end of the conversation if something occurs to you afterwards.
        '<div class="actions">' +
        '<button class="plain wide" data-act="reopen">' + icon('history') + ' Pick this up again</button>' +
        '</div>' +
        '</div>' +
        '</div>'
      );
    }

    /*
     * The box to write a follow-up in, behind the Reply button rather than always open.
     *
     * It sat under every card that needed an answer, above the buttons, so the first thing a
     * card asked for was typing — when the usual answer is one of the three buttons under it.
     * It is rendered either way and hidden until asked for, so a repaint cannot lose what is
     * half-written in it.
     */
    const followUp =
      state === 'approve' || state === 'rejected' || (state === 'waiting' && n.sent)
        ? '<div class="block follow compose">' +
          '<span class="block-label">' +
          '<span class="who">You · follow-up</span>' +
          '<button class="drop" data-act="cancel-reply" title="Discard this reply">' +
          icon('close') +
          '</button>' +
          '</span>' +
          '<div class="ask">' +
          '<textarea rows="1" placeholder="Ask for a change or another attempt…"></textarea>' +
          '<button class="clip" data-act="attach" title="Attach a screenshot to this follow-up">' +
          icon('paperclip') +
          '</button>' +
          '<span class="hint" title="Plain ⏎ starts a new line">' + SEND_KEY + '</span>' +
          '</div>' +
          '</div>'
        : '';

    let actions = '';
    if (sending.has(n.id)) {
      // On its way, and nothing else about the card is worth saying until it lands.
      actions = '<div class="working"><span class="dot"></span>Sending…</div>';
    } else if (n.queued) {
      // Sent while the agent was working. Nothing about the note has changed, so without this
      // the card looked exactly as it did before the click — which reads as a button that does
      // nothing, and the queue is invisible.
      actions =
        '<div class="working"><span class="hold"></span>Queued — goes when Claude finishes' +
        '<button class="undo" data-act="unqueue" title="Do not send this one automatically">Cancel</button>' +
        '</div>';
    } else if (state === 'drafting') {
      actions =
        '<div class="actions">' +
        '<button class="plain" data-act="attach">Attach</button>' +
        '<button class="go" data-act="send">Send to Claude</button>' +
        '</div>';
    } else if (state === 'approve') {
      actions =
        '<div class="actions">' +
        '<button class="approve" data-act="approve">Approve</button>' +
        '<button class="reject" data-act="needswork">Not this</button>' +
        '<button class="plain" data-act="reply">Reply</button>' +
        '</div>';
    } else if (state === 'rejected') {
      /*
       * Turned down. Checked before `awaiting`, which it usually also is: without a report to
       * clear the outcome — the common case with no plugin — the card matched the waiting
       * branch first and showed "Claude is having another go…" over a rejection that had not
       * been sent anywhere, with no buttons at all. A dead end, and a false sentence.
       */
      /*
       * "Another go" only once your reason has actually gone — the last turn is yours and
       * Claude has seen it. Anything looser said it the moment you pressed *Not this*, about a
       * rejection still sitting on the card, which is the sentence this branch existed to stop.
       */
      const turns = n.addenda || [];
      const last = turns[turns.length - 1];
      const going = !!n.awaiting && !!last && !isAgentTurn(last) && seenOf(n) >= turns.length;
      actions =
        '<div class="working">' +
        (going
          ? '<span class="dot"></span>Claude is having another go…'
          : '<span class="hold"></span>Say what was wrong') +
        '<button class="undo" data-act="reply" title="Write what was wrong with it">Write it</button>' +
        '<button class="undo" data-act="approve" title="Accept the change after all">Keep it</button>' +
        '</div>';
    } else if (n.awaiting) {
      /*
       * Who is actually holding it.
       *
       * A batch that only reached the clipboard, or that is staged for a session Redline
       * cannot type into, has not been read by anyone — and the card said "Waiting for
       * Claude…" over it, which is a lie about where the work is and about whose turn it is.
       */
      const route = n.sent && n.sent.route;
      /*
       * A way out of waiting.
       *
       * Nothing brings an answer back on its own unless the plugin is installed, or the
       * session is an Orca one being watched — so on a plain VS Code terminal a card could sit
       * on "Waiting for Claude…" for ever, with no buttons on it at all. *Read the reply*
       * looks for the answer wherever it can be found: the report file, then the session
       * transcript, then the terminal, then the clipboard.
       */
      const look = '<button class="undo" data-global="redline.applyReport" title="Look for Claude\'s answer now">Read the reply</button>';
      actions =
        route === 'clipboard'
          ? '<div class="working"><span class="hold"></span>On your clipboard — paste it into Claude Code' + look + '</div>'
          : route === 'staged'
            ? '<div class="working"><span class="hold"></span>Staged — type the delivery word in your session' + look + '</div>'
            : '<div class="working"><span class="dot"></span>Waiting for Claude…' + look + '</div>';
    } else {
      actions = '<div class="working"><span class="dot"></span>Waiting for Claude…</div>';
    }

    /*
     * The one row that goes with the box: what you can do with what is in it.
     *
     * Rendered beside whatever the state's own row is, and shown instead of it while the box
     * is open — the state's buttons are about the answer you were given, and are noise beside
     * a half-written reply. There used to be a second, near-identical row for a reply that had
     * been recorded but not sent; it was the same two buttons doing the same job, and with the
     * box sending on ⏎ and on Send it was hardly ever reachable. A note that arrives carrying
     * an unsent turn — reopened after being settled, say — simply starts with the box open.
     */
    const composing = followUp && !sending.has(n.id)
      ? '<div class="actions composing">' +
        '<button class="plain" data-act="attach">Attach</button>' +
        '<button class="go" data-act="send-now">Send</button>' +
        '</div>'
      : '';

    /*
     * The box opens itself for a turn that was recorded and never sent — but only where there
     * is a box for it to open into. `replying` also decides which of the two rows the card
     * shows, so on a card with no follow-up box it hid the one row there was and put nothing
     * in its place.
     *
     * `queued` rides along because the stylesheet has to tell the rows apart: the queued row
     * carries the only way to call the send off, and it is hidden by `replying` otherwise.
     */
    const replying = !!followUp && !!n.pendingReply && !sending.has(n.id);

    return (
      '<div class="card ' + state + (n.queued ? ' queued' : '') + (replying ? ' replying' : '') + '"' +
      ' data-id="' + esc(n.id) + '" data-kind="' + esc(n.kind) + '" tabindex="0">' +
      meta +
      snippetBlock(n) +
      '<div class="block mine">' +
      '<span class="block-label">Your request</span>' +
      '<div class="say" data-act="reveal" title="Open in the editor">' + esc(n.body) + '</div>' +
      '</div>' +
      shotsFor(n, false, 0) +
      threadBlocks(n, state === 'rejected', false) +
      pendingShots(n, false) +
      followUp +
      // The actions sit in a band of their own: what you can do is not another paragraph of
      // what was said, and at a glance the card should end somewhere.
      (actions || composing
        ? '<div class="foot">' + '<div class="answering">' + actions + '</div>' + composing + '</div>'
        : '') +
      '</div>'
    );
  }

  function firstLineOf(text) {
    const line = String(text || '').split('\n').find((l) => l.trim()) || '';
    return line.length > 90 ? line.slice(0, 89) + '…' : line;
  }

  /** What the session is doing right now, when the hook is reporting it. */
  var activity = null;

  /**
   * When the session last gave a sign of life, and how long it can go without one.
   *
   * A lost `Stop` signal — a crashed agent, a killed terminal, a hook that never ran — leaves
   * the strip saying "Claude is working…" for half an hour, with queued notes waiting on a
   * finish that is never coming and nothing on screen to suggest the signal was lost. Quiet is
   * only ever a suspicion (a long `Bash` looks the same), so this softens what the strip
   * claims rather than deciding anything.
   */
  var STALE_RUN_MS = 5 * 60 * 1000;
  var lastHeardFrom = 0;

  function runLooksLost() {
    var s = state.session;
    if (!s || s.state !== 'working') return false;
    return lastHeardFrom > 0 && Date.now() - lastHeardFrom > STALE_RUN_MS;
  }

  /**
   * A line under the session strip while a run is going.
   *
   * A silent minute and a hung one look the same otherwise — and the session's own terminal,
   * which would show this, is often not the window you are looking at.
   */
  function activityLine() {
    if (!activity || !activity.running) return '';
    var what = activity.file
      ? '<span class="said">' + esc(activity.file) + '</span>'
      : '<span class="said">working…</span>';
    var count =
      activity.files > 1 ? '<span class="tool">' + activity.files + ' files</span>' : '';
    return '<div class="activity">' + icon('sync') + ' ' + what + count + '</div>';
  }

  function sessionStrip() {
    const s = state.session;
    if (!s) return '';
    const lost = runLooksLost();
    const stateText = lost
      ? 'Claude may no longer be running'
      : s.state === 'working'
        ? 'Claude is working…'
        : s.state === 'idle'
          ? 'watching'
          : 'not watched';
    const who = s.label ? esc(s.label) : 'No Claude Code session detected';
    const hasRecent = typeof s.changedFiles === 'number' && s.changedFiles > 0;
    // Held until the agent is free. Nothing else says so once the status-bar message is gone,
    // and the notes look simply unsent.
    const queuedTitle = lost
      ? 'Claude has not reported for a while. These still go when it finishes — to send one now, ' +
        'use Send on the card itself.'
      : 'They go the moment Claude finishes';
    const queued = s.queued
      ? '<span class="queued" title="' + esc(queuedTitle) + '">' +
        icon('clock') +
        ' ' +
        s.queued +
        ' queued<button data-global="redline.cancelQueued" title="Do not send them automatically">' +
        icon('close') +
        '</button></span>'
      : '';

    /*
     * Who, and what they are doing. One line, and it never wraps: the session name is the
     * long part and it ellipsizes, so the switcher stays where it is whatever it is called.
     */
    const head =
      '<div class="who-row">' +
      '<span class="info" title="' + who + ' — ' + stateText + '">' +
      '<span class="dot"></span>' +
      '<span class="who">' + who + '</span>' +
      '<span class="meta">' + stateText + '</span>' +
      '</span>' +
      queued +
      '<span class="controls">' +
      (s.changesUnavailable
        ? '<span class="wordy" role="button" tabindex="0" data-global="redline.showLog" title="Show the log">Log</span>'
        : '') +
      // Not a `<button>`. The host draws its own chrome on those — a filled, padded box that
      // appears on press and while a command runs — and it kept coming back through states no
      // rule of ours had covered. There is nothing for it to say that the card is not already
      // saying, so this is an icon that behaves like a button and looks like an icon.
      '<span class="swap" role="button" tabindex="0" data-global="redline.pickSession" ' +
      'aria-label="Switch Claude Code session" title="Switch Claude Code session">' +
      icon('arrow-swap') +
      '</span>' +
      '</span>' +
      '</div>';

    // "could not read the file list" must not look like "nothing changed".
    if (s.changesUnavailable) {
      return (
        '<div class="session ' + esc(s.state || 'off') + '">' +
        head +
        '<div class="scope-row"><span class="what">changes unavailable</span></div>' +
        '</div>' +
        // What Claude is writing comes from the hook, not from git, so it is still knowable
        // here — and this is the one branch where nothing else on the strip can tell you
        // anything. Leaving it off took the live line away for the whole run in a folder that
        // is not a worktree, which is exactly where it was the only thing left.
        activityLine()
      );
    }

    /*
     * Short enough to fit beside two buttons in a panel someone has docked narrow.
     *
     * It used to read "1 file changed in the last run (since 11:10) · +2 older", which does not
     * fit, so it clipped mid-word and shoved the buttons off the edge. The count is the part
     * worth reading at a glance; the rest is true, and lives in the tooltip where it costs
     * nothing.
     */
    const detail = hasRecent
      ? String(s.changedFiles) +
        ' file' +
        (s.changedFiles === 1 ? '' : 's') +
        ' changed' +
        (s.rangeLabel ? ' ' + s.rangeLabel : '') +
        (s.olderCount ? ' · and ' + s.olderCount + ' older' : '')
      : 'Nothing has changed here yet';
    const summary = hasRecent
      ? esc(String(s.changedFiles) + ' file' + (s.changedFiles === 1 ? '' : 's')) +
        (s.olderCount ? '<span class="older"> · +' + esc(String(s.olderCount)) + '</span>' : '')
      : '<span class="older">nothing changed yet</span>';

    /*
     * The second row is the review itself: what there is to look at, and the two scopes it can
     * be looked at in.
     *
     * Both buttons are always drawn, and one is disabled rather than removed when it has
     * nothing behind it. The row used to grow and shrink as a run went — one button, then two,
     * then a longer sentence — and the card changed shape under the pointer, moving everything
     * below it. The words change; the shape does not.
     *
     * "Everything" is offered whenever anything differs from the base, not only when it would
     * show more than the last run: it is the escape hatch when that range looks wrong.
     */
    const hasAny = typeof s.totalFiles === 'number' && s.totalFiles > 0;
    const scopeButton = (cmd, label, on, count, hint) =>
      on
        ? '<button data-global="' + cmd + '" title="' + hint + ' — ' + esc(String(count)) + ' file(s)">' + label + '</button>'
        : '<button class="off" disabled title="Nothing to show here yet">' + label + '</button>';
    const scope =
      '<span class="scope">' +
      scopeButton('redline.reviewChanges', 'Last run', hasRecent, s.changedFiles, 'Diff the last run') +
      scopeButton('redline.reviewAllChanges', 'Everything', hasAny, s.totalFiles, 'Diff every change since the base') +
      '</span>';

    return (
      '<div class="session ' + esc(s.state || 'off') + '">' +
      head +
      '<div class="scope-row"><span class="what" title="' + esc(detail) + '">' + summary + '</span>' + scope + '</div>' +
      '</div>' +
      activityLine()
    );
  }

  /**
   * Which notes to show. A round of twenty leaves the two that still need you buried in the
   * ones that are settled, and scrolling to find them is the whole problem.
   *
   *   waiting  — you have not sent it, or you have and nothing has come back
   *   answered — Claude replied or changed the code, and you have not closed it out
   *   done     — settled, kept for the record
   */
  var FILTERS = ['all', 'waiting', 'answered', 'done'];
  var FILTER_LABEL = { all: 'all', waiting: 'waiting', answered: 'answered', done: 'done' };
  var filter = 'all';

  /**
   * Which chip a card belongs under — decided by the card's own state, not by a second reading
   * of the same fields.
   *
   * They disagreed: a note Claude had reported done but nobody had approved filed under *done*
   * while the card itself said *Needs approval* and sorted to the top. Filtering to find what
   * needed approving hid exactly those.
   */
  function bucket(n) {
    const state = cardState(n);
    if (state === 'done') return 'done';
    if (state === 'approve' || state === 'rejected') return 'answered';
    return 'waiting';
  }

  function keep(n) {
    return filter === 'all' || bucket(n) === filter;
  }

  /** Below this there is nothing to lose in a list, and the chips are not worth the room. */
  const FILTER_FROM = 6;

  function filterBar(counts, total) {
    if (total < FILTER_FROM) return '';
    var html = '<div class="filters">';
    for (var i = 0; i < FILTERS.length; i++) {
      var f = FILTERS[i];
      var n = f === 'all' ? total : counts[f] || 0;
      if (f !== 'all' && n === 0) continue;
      html +=
        '<button class="chip' + (filter === f ? ' on' : '') + '" data-filter="' + f + '">' +
        FILTER_LABEL[f] + ' <span class="n">' + n + '</span></button>';
    }
    return html + '</div>';
  }

  function render() {
    if (!ready) return;
    const all = (state.cards || []).concat(state.sent || []);
    if (all.length === 0) {
      paint(
        sessionStrip(),
        '<div class="empty">No review notes yet.<br><br><b>Start with the diff.</b> <span class="link" data-global="redline.reviewChanges">Review the last run</span> opens what Claude changed; leave notes on the lines that need work.<br><br><b>Leaving a note.</b> Put the cursor on a line — or select some — and press ⌘R / Ctrl+R. Hovering the gutter and clicking the ➕ does the same. ⌘⌥M types it into a prompt instead.<br><br><b>Screenshots.</b> Paste with ⌘V onto a note, click 📎, or hold ⇧ while dragging the image onto a card.<br><br><span class="link" data-global="redline.setUpHook">Set up the Claude Code plugin</span> for exact per-run diffs and answers that come back as a file.</div>',
      );
      return;
    }
    const counts = {};
    for (let i = 0; i < all.length; i++) {
      const b = bucket(all[i]);
      counts[b] = (counts[b] || 0) + 1;
    }
    /*
     * A filter that hides everything is a dead end, so it gives way rather than showing a
     * blank panel. So is one whose chips are no longer on screen: the bar is only drawn once
     * there is enough to lose something in, and approving your way below that left the list
     * still filtered with nothing anywhere to clear it.
     */
    if (filter !== 'all' && (!(counts[filter] > 0) || all.length < FILTER_FROM)) filter = 'all';
    // One column, no file headers: the cards come from all over a change, so a header was
    // mostly one card each, and every card names its own file.
    paint(
      sessionStrip(),
      filterBar(counts, all.length) +
        '<div class="list">' +
        all
          .filter(keep)
          // Settled cards sink. What still needs you is what you came to the panel for, and a
          // round of twenty leaves the two live ones buried among the ones that are finished.
          .sort((a, b) => (cardState(a) === 'done' ? 1 : 0) - (cardState(b) === 'done' ? 1 : 0))
          .map(card)
          .join('') +
        '</div>',
    );
  }

  /**
   * Write the panel, but only the half that would actually differ.
   *
   * Every store change re-renders, and a store change happens for things that do not touch
   * this markup at all — a run finishing, a note's hash being refreshed, the range being
   * recomputed. Rebuilding identical HTML re-parses every card, drops the scroll position and
   * loses any text selection, which is what made the panel feel like it was flickering while
   * Claude worked.
   *
   * The header and the cards are compared separately because the header changes constantly
   * and the cards hardly ever do: it carries the name of the file Claude is writing *now*, so
   * sharing one string meant every file it touched re-parsed all hundred cards — thirty full
   * rebuilds in a single run, for a line of text at the top.
   */
  var paintedStrip;
  var paintedBody;
  var stripEl;
  var bodyEl;

  function containers() {
    if (stripEl && stripEl.isConnected) return;
    root.innerHTML = '<div id="strip"></div><div id="cards"></div>';
    stripEl = document.getElementById('strip');
    bodyEl = document.getElementById('cards');
    paintedStrip = undefined;
    paintedBody = undefined;
  }

  function paint(strip, body) {
    containers();
    if (strip !== paintedStrip) {
      paintedStrip = strip;
      stripEl.innerHTML = strip;
    }
    if (body === paintedBody) return;
    paintedBody = body;
    // Not every host gives us a scrolling element — guard rather than assume, since throwing
    // here would take the whole panel down.
    var scroller = document.scrollingElement || document.documentElement;
    var top = scroller ? scroller.scrollTop : 0;
    // What is being typed, and where in it the cursor is. The DOM is about to be replaced, so
    // without this a repaint mid-sentence would take both — which is why repaints used to be
    // held back while a box had focus, and why a finished turn took until the next click to
    // appear. Carrying them over costs nothing and lets the panel keep up.
    var drafts = openBoxes();
    // Taken before anything is restored, and cleared whether or not it is used. Left armed, it
    // fires on whatever repaint next happens to find no box focused — a session poll thirty
    // seconds later, with the cursor pulled into a card nobody was looking at.
    var wanted = focusAfterRender;
    focusAfterRender = undefined;
    bodyEl.innerHTML = body;
    for (var d = 0; d < drafts.length; d++) restoreBox(drafts[d]);
    if (drafts.length === 0 && wanted) restoreBox({ id: wanted, value: '', start: 0, end: 0, focused: true });
    // Restoring unconditionally would fight a deliberate scroll-to-top; only put it back when
    // the content is still tall enough for the old position to mean anything. `>=`, not `>`:
    // at the exact bottom `top` *is* `scrollHeight - clientHeight`, so the strict form read
    // "that position no longer exists" for the one place people leave the panel — on the last
    // card, waiting for the report — and every repaint threw them back to the top.
    if (scroller && top > 0 && scroller.scrollHeight - scroller.clientHeight >= top) {
      scroller.scrollTop = top;
    }
  }

  /** A card whose box the next repaint should put the cursor in — see `needswork`. */
  var focusAfterRender;

  /*
   * Cards whose reply has been sent and whose card has not caught up yet.
   *
   * Sending is three things in a row — record the turn, hand it to the extension, hear back —
   * and each one repaints. Without this the card fell back to *Approve · Not this · Reply* for
   * a frame in between, which is the one row that is certainly wrong at that moment: the
   * answer is already on its way. Held across repaints and dropped the moment the note itself
   * says where it went.
   */
  var sending = new Set();

  var sendingTimer = 0;

  function markSending(id) {
    if (!id) return;
    sending.add(id);
    // Nothing should hold this state open for ever: if the extension never answers, the card
    // goes back to saying what it actually knows.
    if (sendingTimer) clearTimeout(sendingTimer);
    sendingTimer = setTimeout(function () {
      sendingTimer = 0;
      sending.clear();
      scheduleRender();
    }, 20000);
  }

  /** The card being typed into, what is in the box, and where the cursor sits in it. */
  /**
   * Every reply being written, not only the one the cursor happens to be in.
   *
   * A draft lives in the DOM and nowhere else, so a repaint is the only thing that can lose
   * it — and it only takes the cursor to be somewhere else at that moment. Clicking Attach is
   * exactly that: focus moves to the button, picking a file changes the store, the panel
   * repaints, and the words that were about to have a screenshot attached to them are gone.
   * That is the workflow the button exists for.
   */
  function openBoxes() {
    var out = [];
    var boxes = root.querySelectorAll ? root.querySelectorAll('textarea') : [];
    for (var i = 0; i < boxes.length; i++) {
      var ta = boxes[i];
      var card = ta.closest ? ta.closest('.card') : null;
      if (!card || !card.dataset || !card.dataset.id) continue;
      var focused = document.activeElement === ta;
      // Empty and unfocused is not a draft; carrying it would reopen boxes nobody opened.
      if (!focused && !(ta.value && ta.value.trim())) continue;
      out.push({
        id: card.dataset.id,
        value: ta.value,
        start: ta.selectionStart,
        end: ta.selectionEnd,
        focused: focused,
      });
    }
    return out;
  }

  function restoreBox(box) {
    // Nothing to carry across for a card whose reply has already gone: reopening the box over
    // a send in flight is the one thing that must not happen here.
    if (sending.has(box.id)) return;
    var card = cardById(box.id);
    var ta = card && card.querySelector ? card.querySelector('textarea') : undefined;
    if (!ta) return;
    // The box is hidden until Reply asks for it, and that is a class on the card rather than
    // anything the store knows — so a repaint would close it under whatever is half-written.
    if (card.classList) card.classList.add('replying');
    // A box the render has already filled — a draft the extension host knows about — wins:
    // overwriting it with a stale copy would undo whatever put it there.
    if (!ta.value) ta.value = box.value;
    // Only the one the cursor was actually in: restoring several drafts must not fight over it.
    if (box.focused !== false && ta.focus) ta.focus();
    // Not every host implements selection on a detached-then-reattached box; a caret at the
    // end is a good deal better than an exception that takes the panel down.
    try {
      if (ta.setSelectionRange && ta.value === box.value) ta.setSelectionRange(box.start, box.end);
    } catch (e) {
      /* the caret lands at the end */
    }
  }

  function scheduleRender() {
    if (isBusy()) {
      pendingRender = true;
      return;
    }
    render();
  }

  function flushPendingRender() {
    setTimeout(() => {
      if (pendingRender && !isBusy()) {
        pendingRender = false;
        render();
      }
    }, 60);
  }

  // ── popups ───────────────────────────────────────────────────────────

  let popup;
  function closePopup() {
    if (popup) {
      popup.remove();
      popup = undefined;
    }
  }
  function openPopup(anchor, html, onPick) {
    closePopup();
    popup = document.createElement('div');
    popup.className = 'menu';
    popup.setAttribute('role', 'menu');
    popup.innerHTML = html;
    popup.addEventListener('click', (ev) => {
      onPick(ev);
      closePopup();
    });
    /*
     * Reachable without a mouse.
     *
     * The items are divs — a menu of them inside a webview gets no keyboard behaviour of its
     * own — so the popup carries its own: arrows to move, ⏎/space to choose, Escape to leave,
     * and focus handed back to the control that opened it so you are not dropped at the top
     * of the panel. Without this the ⋯ menu could be opened from the keyboard and then not
     * used, which is worse than not being reachable at all.
     */
    const items = [].slice.call(popup.children);
    for (const it of items) {
      it.setAttribute('tabindex', '-1');
      it.setAttribute('role', 'menuitem');
    }
    popup.addEventListener('keydown', (ev) => {
      const at = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closePopup();
        if (anchor.focus) anchor.focus();
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const step = ev.key === 'ArrowDown' ? 1 : -1;
        const next = items[(at + step + items.length) % items.length];
        if (next && next.focus) next.focus();
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (document.activeElement && document.activeElement.click) document.activeElement.click();
      }
    });
    document.body.appendChild(popup);
    const r = anchor.getBoundingClientRect();
    popup.style.left = Math.max(4, Math.min(r.left, window.innerWidth - popup.offsetWidth - 8)) + 'px';
    popup.style.top =
      Math.min(r.bottom + window.scrollY + 2, window.scrollY + window.innerHeight - popup.offsetHeight - 8) +
      'px';
    if (items[0] && items[0].focus) items[0].focus();
  }

  /** Actions that run git, `ps` or the Orca CLI, and so take long enough to show. */
  const SLOW_ACTS = new Set(['send', 'attach']);

  // ── interactions ─────────────────────────────────────────────────────

  root.addEventListener('pointerdown', (e) => {
    const cardEl = e.target && e.target.closest ? e.target.closest('.card') : null;
    if (cardEl) lastCardId = cardEl.dataset.id;
  });

  root.addEventListener('click', (e) => {
    const shot = e.target.closest('[data-shot]');
    const unshot = e.target.closest('[data-unshot]');
    if (unshot) {
      const c = unshot.closest('.card');
      post({ type: 'removeAttachment', id: c && c.dataset.id, text: unshot.dataset.unshot });
      return;
    }
    if (shot) {
      post({ type: 'openAttachment', text: shot.dataset.shot });
      return;
    }
    const ref = e.target.closest('[data-open]');
    if (ref) {
      post({ type: 'openPath', text: ref.dataset.open });
      return;
    }
    const chip = e.target.closest('[data-filter]');
    if (chip) {
      // Clicking the lit one clears it, so the filter never needs a separate reset.
      filter = filter === chip.dataset.filter ? 'all' : chip.dataset.filter;
      render();
      return;
    }
    const global = e.target.closest('[data-global]');
    if (global) {
      if (global.classList.contains('busy')) return; // already running
      markBusy(global);
      cmd(global.dataset.global);
      return;
    }
    const el = e.target.closest('[data-act]');
    const cardEl = e.target.closest('.card');
    if (!el || !cardEl) {
      closePopup();
      return;
    }
    const id = cardEl.dataset.id;
    if (el.classList.contains('busy')) return; // already running
    // Only the actions that leave the extension host: the rest are instant, and a spinner
    // that flashes for one frame is worse than none.
    if (SLOW_ACTS.has(el.dataset.act)) markBusy(el);
    switch (el.dataset.act) {
      case 'reveal':
        cmd('redline.revealNote', id);
        break;
      case 'approve':
        cmd('redline.approveNote', id);
        break;
      case 'needswork':
        // The reason goes on this card. Nothing is opened in the editor: turning a change
        // down used to reveal and focus the widget's reply box, which took you out of the
        // panel to type into a second box that asked for the same thing.
        focusAfterRender = id;
        cmd('redline.needsWork', id);
        break;
      case 'done':
      case 'reopen':
        cmd('redline.toggleDone', id);
        break;
      case 'remove':
        cmd('redline.deleteNote', id);
        break;
      case 'send':
        cmd('redline.sendSelected', id);
        break;

      case 'attach':
        post({ type: 'attachPick', id });
        break;
      case 'reply': {
        // Open the box, or take what is already in it. Pressing Reply on a box you have just
        // typed into used to do nothing at all: it only moved focus to where the cursor was.
        if (cardEl.classList.contains('replying') && commitFollowUp(cardEl)) break;
        cardEl.classList.add('replying');
        const box = cardEl.querySelector('textarea');
        if (box && box.focus) box.focus();
        break;
      }
      case 'unqueue':
        // This card, not everyone's queue. It said "do not send *it*" and called off the lot.
        cmd('redline.cancelQueued', id);
        break;
      case 'send-now': {
        // Written and sent in one press. Committing and sending were two steps because a reply
        // often wants a screenshot attached first — but that is what Attach beside it is for,
        // and making every reply cost two clicks to spare that one was the wrong trade.
        // Something to send: what is in the box, or a turn already recorded and not yet gone.
        // Neither, and this re-sent the whole note to Claude — a live button doing the one
        // thing nobody pressing it could have meant.
        const wrote = commitFollowUp(cardEl);
        const n = findNote(id);
        if (!wrote && !(n && n.pendingReply)) {
          cardEl.classList.remove('replying');
          break;
        }
        markSending(id);
        cmd('redline.sendSelected', id);
        render();
        break;
      }
      case 'cancel-reply': {
        /*
         * Changed your mind about what is in the box. Only about that: a turn that has already
         * been recorded — which is what `pendingReply` means, and it is committed by the Reply
         * before this one — has its own ✕ on the block that shows it, and this must not look
         * like it threw that away too.
         *
         * So a card the repaint opens because a turn is pending stays open. Closing it revealed
         * the state's own row, which on a sent note reads "Waiting for Claude…" over a note
         * that is in fact waiting on you to press Send — and the next repaint put the box
         * straight back anyway.
         */
        const box = cardEl.querySelector('textarea');
        if (box) box.value = '';
        const pending = findNote(id);
        if (!(pending && pending.pendingReply)) cardEl.classList.remove('replying');
        break;
      }
      case 'undo-turn':
        // Only an unsent one is offered, so nothing Claude has seen can be rewritten.
        post({ type: 'dropTurn', id, text: el.dataset.turn });
        break;
      case 'expand':
        // A settled card keeps what was said; it just does not spend the room on it until
        // someone wants to read it back.
        if (unfolded.has(id)) unfolded.delete(id);
        else unfolded.add(id);
        render();
        break;
      case 'unclip':
        if (unclipped.has(id)) unclipped.delete(id);
        else unclipped.add(id);
        render();
        break;
      case 'kind':
        openPopup(
          el,
          state.kinds
            .map(
              (k) =>
                '<div data-kind="' + k.kind + '"><span class="mi">' + icon(k.icon) + '</span>' + esc(k.label) + '</div>',
            )
            .join(''),
          (ev) => {
            const k = ev.target.closest('[data-kind]');
            if (k) post({ type: 'setKind', id, kind: k.dataset.kind });
          },
        );
        e.stopPropagation();
        break;
      case 'more': {
        const n = findNote(id);
        const items = [];
        // Everything that does not earn a place in the card's own row of actions.
        items.push(['attach', icon('file-media'), 'Attach a screenshot']);
        // Only on a note that has lost its lines. The card says so, and until now said it with
        // no way to act on it: the command existed and reached no menu at all.
        if (n && n.orphaned) items.push(['reanchor', icon('pin'), 'Re-anchor at the cursor']);
        if (n && n.done) items.push(['reopen', icon('history'), 'Reopen this note']);
        else if (n && n.sent) items.push(['done', icon('check'), 'Mark done without asking again']);
        items.push(['copy', icon('copy'), 'Copy this note']);
        items.push(['delete', icon('trash'), 'Delete note']);
        openPopup(
          el,
          items
            .map(
              (it) =>
                '<div data-menu-act="' + it[0] + '"><span class="mi">' + it[1] + '</span>' + esc(it[2]) + '</div>',
            )
            .join(''),
          (ev) => {
            const mi = ev.target.closest('[data-menu-act]');
            if (!mi) return;
            const what = mi.dataset.menuAct;
            // Two of these are panel-side, the rest are commands.
            if (what === 'attach') {
              post({ type: 'attachPick', id });
              return;
            }
            const map = {
              copy: 'redline.copyNote',
              delete: 'redline.deleteNote',
              done: 'redline.toggleDone',
              reopen: 'redline.toggleDone',
              reanchor: 'redline.reanchorNote',
            };
            const command = map[what];
            if (command) cmd(command, id);
          },
        );
        e.stopPropagation();
        break;
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('[data-act="kind"]') && !e.target.closest('[data-act="more"]')) {
      closePopup();
    }
  });

  /**
   * Take what is in a card's follow-up box, if anything is.
   *
   * Recorded, not sent: a reply often wants a screenshot attached before it goes, so the card
   * marks it *not sent yet* and the send stays a separate, deliberate act. Returns whether
   * there was anything to take, so a caller can do something else when there was not.
   */
  function commitFollowUp(cardEl) {
    const ta = cardEl && cardEl.querySelector ? cardEl.querySelector('textarea') : undefined;
    if (!ta || !ta.value || !ta.value.trim()) return false;
    post({ type: 'addAddendum', id: cardEl.dataset.id, text: ta.value });
    ta.value = '';
    cardEl.classList.remove('replying');
    // Let go of it. `paint` carries a focused box across a repaint, cursor and all — which is
    // right while you are typing and wrong the instant you are not: it read a box that had
    // just been emptied and handed off as one being typed in, put the card back into
    // `replying`, and hid the "Sending…" row behind an empty box with no buttons under it.
    if (ta.blur) ta.blur();
    return true;
  }

  root.addEventListener('keydown', (e) => {
    // Anything acting as a button answers ⏎ and space, which is the whole of what a real
    // `<button>` was giving us in exchange for chrome we could not turn off.
    if (e.key === 'Enter' || e.key === ' ') {
      const pressed = e.target.closest ? e.target.closest('[role="button"]') : null;
      if (pressed) {
        e.preventDefault();
        if (pressed.click) pressed.click();
        return;
      }
    }
    const ta = e.target.closest('textarea');
    if (ta && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      const cardEl = ta.closest('.card');
      if (!cardEl) return;
      // Sends, the same as pressing Send. It only recorded the turn, so the shortcut and the
      // button next to it did different things — and the shortcut left the reply sitting on
      // the card needing a second press that the hint beside it said nothing about.
      if (ta.value && ta.value.trim()) {
        markSending(cardEl.dataset.id);
        commitFollowUp(cardEl);
        cmd('redline.sendSelected', cardEl.dataset.id);
        render();
      } else {
        cardEl.classList.remove('replying');
      }
    }
  });

  // ── screenshots ──────────────────────────────────────────────────────

  function sendImage(id, name, blob) {
    const reader = new FileReader();
    reader.onload = () => {
      const parts = String(reader.result).split(',');
      post({ type: 'attach', id, name, data: parts[1] || '' });
    };
    reader.readAsDataURL(blob);
  }

  /**
   * Paste an image onto a card. A render drops focus to <body>, so fall back to the card
   * last interacted with — otherwise ⌘V right after touching a note does nothing.
   */
  document.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    const active = document.activeElement;
    const focused = active && active.closest ? active.closest('.card') : null;
    const id = focused ? focused.dataset.id : lastCardId;
    if (!id) return;
    for (const it of e.clipboardData.items || []) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          sendImage(id, f.name || 'pasted.png', f);
        }
      }
    }
  });

  // ── drag & drop ──────────────────────────────────────────────────────
  /* How VS Code treats a file drag over a webview (verified against the shipped
   * workbench, not guessed):
   *
   *   1. Our `dragenter` bubbles to the preload's own window listener, which posts
   *      `drag-start` to the host → the host sets `pointer-events: none` on the whole
   *      panel. It skips that when the event is already `defaultPrevented` — which is why
   *      the handler below calls preventDefault() on dragenter, not just dragover.
   *   2. Every `dragover` makes the preload post `drag: {shiftKey}`, which the host
   *      re-dispatches on the workbench window, where `shiftKey ? unblock() : block()`.
   *      So the propagation must NOT be stopped: that message is the only way the
   *      workbench learns Shift is down while the pointer is over the panel.
   *
   * Net effect: the panel receives drag events only while ⇧ is held, and they stop dead
   * the moment it is released — with no dragleave and no dragend. Hence a TTL heartbeat
   * rather than exit-event cleanup, and the one-time hint when ⇧ is missing.
   */

  /** Note id of the highlighted card — never the element, which a re-render replaces. */
  let dropCardId;
  let dropTimer = 0;
  let shiftHintSent = false;

  const cardById = (id) => (id ? root.querySelector('.card[data-id="' + id + '"]') : null);

  function clearDrop() {
    if (dropTimer) {
      clearTimeout(dropTimer);
      dropTimer = 0;
    }
    const el = cardById(dropCardId);
    if (el) el.classList.remove('dropping');
    dropCardId = undefined;
    if (dragging) {
      dragging = false;
      // A render held back during the drag can now happen.
      flushPendingRender();
    }
  }

  /** The events stop arriving when ⇧ is released or the pointer leaves the panel — no
   *  dragleave, no dragend, nothing. So the highlight expires unless renewed. The window
   *  must exceed the browser's idle `dragover` interval (~350 ms while the pointer is
   *  stationary) or a motionless hover would flicker. */
  const DROP_TTL_MS = 700;

  function keepAlive() {
    dragging = true;
    if (dropTimer) clearTimeout(dropTimer);
    dropTimer = setTimeout(clearDrop, DROP_TTL_MS);
  }

  function highlight(card) {
    const id = card ? card.dataset.id : undefined;
    if (id !== dropCardId) {
      const old = cardById(dropCardId);
      if (old) old.classList.remove('dropping');
      dropCardId = id;
      if (card) card.classList.add('dropping');
    } else if (card && !card.classList.contains('dropping')) {
      // Same note, new element: a render swapped the DOM out from under the drag.
      card.classList.add('dropping');
    }
    keepAlive();
  }

  /** True when the payload could be an image: OS files, or a uri-list from a browser. */
  function looksDroppable(dt) {
    if (!dt) return false;
    const types = Array.prototype.slice.call(dt.types || []);
    return types.indexOf('Files') >= 0 || types.indexOf('text/uri-list') >= 0;
  }

  /** The card under the pointer. `e.target` is enough while pointer events are enabled;
   *  elementFromPoint covers the case where the event retargets to the document. */
  function cardFor(e) {
    let node = e.target;
    if (!node || !node.closest) node = document.elementFromPoint(e.clientX, e.clientY);
    if (!node || !node.closest) return null;
    return node.closest('.card');
  }

  const onDragOver = guard('dragover', (e) => {
    if (!looksDroppable(e.dataTransfer)) return;
    // Also on dragenter: an unprevented dragenter is what makes the host disable pointer
    // events over the panel for the rest of the drag.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!e.shiftKey) {
      // This is the last event we will see: the workbench is about to block the panel.
      // Say so once, rather than leaving the drag silently dead.
      if (!shiftHintSent) {
        shiftHintSent = true;
        post({ type: 'dragNeedsShift' });
      }
      clearDrop();
      return;
    }
    highlight(cardFor(e));
  });

  document.addEventListener('dragenter', onDragOver);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', guard('dragleave', keepAlive));
  document.addEventListener('dragend', guard('dragend', clearDrop));
  window.addEventListener('blur', clearDrop);

  document.addEventListener(
    'drop',
    guard('drop', (e) => {
      e.preventDefault();
      const card = cardFor(e) || cardById(dropCardId);
      clearDrop();
      const dt = e.dataTransfer;
      if (!dt) return;
      // No card under the pointer (the drop landed on a file header or empty space): let
      // the extension resolve the target — one note is used directly, several are offered.
      const id = card ? card.dataset.id : undefined;

      // Bytes when the source gives us a real file — the same route ⌘V uses, and the only
      // one that works for a drag out of a browser or a sandboxed app.
      let sent = 0;
      const files = dt.files ? Array.prototype.slice.call(dt.files) : [];
      for (const f of files) {
        if (f.type ? f.type.indexOf('image/') === 0 : /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i.test(f.name || '')) {
          sendImage(id, f.name || 'dropped.png', f);
          sent++;
        }
      }
      if (sent > 0) return;

      // Otherwise fall back to paths; the extension validates and reads them.
      let uris = '';
      try {
        uris = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
      } catch (_) {
        uris = '';
      }
      if (uris) post({ type: 'attachPaths', id, uris });
      else post({ type: 'dropRejected', id });
    }),
  );

  // ── extension messages ───────────────────────────────────────────────

  window.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'notes') {
      clearBusy();
      state.cards = msg.cards || [];
      state.sent = msg.sent || [];
      // A card that is queued, or whose turn has gone, has answered the question this was
      // covering for. Anything still in flight keeps saying so.
      for (const n of state.cards.concat(state.sent)) {
        if (sending.has(n.id) && (n.queued || !n.pendingReply)) sending.delete(n.id);
      }
      state.kinds = msg.kinds || state.kinds;
      ready = true;
      scheduleRender();
    } else if (msg.type === 'activity') {
      activity = msg.activity || null;
      // The hook only reports activity when the agent touches something, so any of these is
      // proof the run is alive.
      lastHeardFrom = Date.now();
      scheduleRender();
    } else if (msg.type === 'idle') {
      // The extension finished whatever the last click started.
      clearBusy();
    } else if (msg.type === 'session') {
      clearBusy();
      // Only the moment it *becomes* busy counts as a sign of life: the strip is posted again
      // every half minute whatever the agent is doing, so treating each post as news would
      // mean a dead run never looked quiet.
      const wasWorking = state.session && state.session.state === 'working';
      state.session = msg.session || null;
      const working = state.session && state.session.state === 'working';
      if (!working) lastHeardFrom = 0;
      else if (!wasWorking) lastHeardFrom = Date.now();
      if (ready) scheduleRender();
    }
  });

  post({ type: 'ready' });
})();
