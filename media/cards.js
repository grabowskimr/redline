/* Review Notes panel. Runs inside the webview; talks to the extension via postMessage.
 * State arrives in two independent messages so slow/failing session lookups can never
 * stop the notes from rendering:
 *   { type: 'notes',   groups, sent, kinds } — cheap, always sent first
 *   { type: 'session', session: … } — best-effort, may never arrive
 */
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  /** @type {{cards: any[], sent: any[], kinds: any[], session: any}} */
  let state = { cards: [], sent: [], kinds: [], session: null };
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
  let busyRestore = '';

  function clearBusy() {
    if (busyTimer) {
      clearTimeout(busyTimer);
      busyTimer = 0;
    }
    if (busyEl) {
      if (busyEl.isConnected) busyEl.innerHTML = busyRestore;
      busyEl.classList.remove('busy');
      const scope = busyEl.closest('.actions') || busyEl.closest('.controls');
      if (scope) scope.classList.remove('working');
      busyEl = undefined;
    }
  }

  const BUSY_TIMEOUT_MS = 20000;

  function markBusy(el) {
    // Buttons only: `.body` also carries a `data-act`, and swapping its contents would
    // replace the note's own text with a spinner.
    if (!el || el.tagName !== 'BUTTON') return;
    clearBusy();
    busyEl = el;
    busyRestore = el.innerHTML;
    el.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin"></span>';
    el.classList.add('busy');
    // Dim the neighbours so a second click on a different action is obviously not wanted.
    const scope = el.closest('.actions') || el.closest('.controls');
    if (scope) scope.classList.add('working');
    busyTimer = setTimeout(clearBusy, BUSY_TIMEOUT_MS);
  }

  /** Notes are edited in the comment widget, so a textarea is the only editable surface. */
  function isEditing() {
    const a = document.activeElement;
    return !!a && a.tagName === 'TEXTAREA';
  }

  /** Re-rendering replaces the DOM wholesale — never do it under the user's hands. */
  function isBusy() {
    return isEditing() || dragging;
  }

  function findNote(id) {
    for (const n of state.cards || []) if (n.id === id) return n;
    for (const n of state.sent) if (n.id === id) return n;
    return {};
  }

  // ── rendering ────────────────────────────────────────────────────────

  function statusOf(n) {
    if (!n.sent) return '';
    if (n.done) return icon('pass-filled') + ' approved';
    // Claude saying it is finished is a claim about the code, not a verdict on it. The note
    // waits for someone to look — which is the whole point of reviewing.
    if (awaitingApproval(n)) return icon('eye') + ' waiting for approval';
    const o = n.sent.outcome;
    if (o === 'done') return icon('pass-filled') + ' done';
    if (o === 'skipped') return icon('circle-slash') + ' skipped' + (n.sent.reply ? ' — ' + esc(n.sent.reply) : '');
    if (o === 'answered') return '💬 answered';
    return n.sent.changed ? icon('diff-modified') + ' code changed' : icon('clock') + ' not addressed yet';
  }

  /** A note Claude has finished with, that nobody has agreed with yet. */
  function awaitingApproval(n) {
    return !!n.sent && !n.done && !n.pendingReply && (n.sent.outcome === 'done' || n.sent.changed);
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

  function codeBox(cls, label, code, act) {
    return (
      '<pre class="' +
      cls +
      '" data-act="' +
      act +
      '"><span class="label">' +
      label +
      '</span><span class="code">' +
      esc(dedent(code)) +
      '</span></pre>'
    );
  }

  const AGENT_PREFIX = 'Claude:';

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

  const STATE_WORD = {
    drafting: 'Drafting',
    waiting: 'Sent',
    approve: 'Needs approval',
    rejected: 'Rejected',
    done: 'Done',
  };

  /** The lines the note was written about, with their real numbers beside them. */
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
    return '<pre class="snip" data-act="reveal" title="Open in the editor">' + rows + '</pre>';
  }

  /** Claude's turn: what it changed, or what it answered. */
  function claudeBlock(n, dimmed) {
    const said = latestAgentTurn(n);
    if (!said) return '';
    const label = n.sent && n.sent.outcome === 'answered' ? "Claude's answer" : "Claude's change";
    return (
      '<div class="block claude' + (dimmed ? ' dim' : '') + '">' +
      '<span class="block-label">' + label + '</span>' +
      '<div class="block-body">' + inlineMarkdown(said) + '</div>' +
      '</div>'
    );
  }

  /** The reason a change was turned down — your words, kept beside the answer they refuse. */
  function rejectionBlock(n) {
    const why = latestOwnTurn(n);
    if (!why) return '';
    return (
      '<div class="block reject">' +
      '<span class="block-label">You · rejected</span>' +
      '<div class="block-body">' + inlineMarkdown(why) + '</div>' +
      '</div>'
    );
  }

  /** The newest thing Claude said in the thread. */
  function latestAgentTurn(n) {
    const turns = (n.addenda || []).filter(isAgentTurn);
    const last = turns[turns.length - 1];
    if (last) return String(last).replace(AGENT_PREFIX, '').trim();
    return n.sent && n.sent.reply ? n.sent.reply : '';
  }

  /** The newest thing you said after Claude's last turn. */
  function latestOwnTurn(n) {
    const turns = n.addenda || [];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (!isAgentTurn(turns[i])) return String(turns[i]).trim();
    }
    return '';
  }

  /** Screenshots attached to a note, removable while the note is still live. */
  function shotsOf(n, settled) {
    const shots = n.attachments || [];
    if (shots.length === 0) return '';
    return (
      '<div class="shots">' +
      shots
        .map(
          (a) =>
            '<span class="shot"><img src="' +
            esc(a.src) +
            '" alt="' +
            esc(a.name) +
            '" title="' +
            esc(a.name) +
            ' — click to open" data-shot="' +
            esc(a.path) +
            '">' +
            (settled
              ? ''
              : '<span class="x" data-unshot="' + esc(a.path) + '" title="Remove screenshot">' + icon('close') + '</span>') +
            '</span>',
        )
        .join('') +
      '</div>'
    );
  }

  function card(n) {
    const state = cardState(n);
    const meta =
      '<div class="meta">' +
      '<span class="state ' + state + '">' + esc(STATE_WORD[state] || '') + '</span>' +
      '<span class="ref' + (n.missing ? ' gone' : n.orphaned ? ' stale' : '') + '"' +
      (n.missing
        ? ' title="This file has been deleted — the note is kept for the record"'
        : n.orphaned
          ? ' title="The code this note pointed at has moved; the line may be wrong"'
          : '') +
      '>' +
      '<span class="kind" data-act="kind" title="' + esc(n.kindLabel) + '" style="color:' + esc(n.kindColor) + '">' +
      icon(n.kindIcon) +
      '</span>' +
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
        '<div class="card done" data-id="' + esc(n.id) + '" data-kind="' + esc(n.kind) + '" tabindex="0">' +
        snippetBlock(n) +
        '<div class="summary" data-act="expand">' +
        '<span class="state done">Done</span>' +
        '<span class="what">' + esc(firstLineOf(n.body)) + '</span>' +
        '<span class="ref">' + esc(n.fileRef) + '</span>' +
        '</div>' +
        '<div class="folded">' +
        '<div class="say" data-act="reveal" title="Open in the editor">' + esc(n.body) + '</div>' +
        claudeBlock(n, false) +
        '</div>' +
        '</div>'
      );
    }

    const followUp =
      state === 'approve'
        ? '<div class="block follow">' +
          '<span class="block-label">You · follow-up</span>' +
          '<div class="ask">' +
          '<textarea rows="1" placeholder="Ask for a change or another attempt…"></textarea>' +
          '<span class="hint">⏎</span>' +
          '</div>' +
          '</div>'
        : '';

    let actions = '';
    if (state === 'drafting') {
      actions = '<div class="actions"><button class="go wide" data-act="send">Send to Claude</button></div>';
    } else if (state === 'approve') {
      actions =
        '<div class="actions">' +
        '<button class="approve" data-act="approve">Approve</button>' +
        '<button class="reject" data-act="needswork">Not this</button>' +
        '<button class="plain" data-act="reply">Reply</button>' +
        '</div>';
    } else if (state === 'rejected') {
      actions = '<div class="working"><span class="dot"></span>Claude is working on it…</div>';
    } else if (n.pendingReply) {
      actions = '<div class="actions"><button class="go wide" data-act="send">Send your reply</button></div>';
    } else {
      actions = '<div class="working"><span class="dot"></span>Waiting for Claude…</div>';
    }

    return (
      '<div class="card ' + state + '" data-id="' + esc(n.id) + '" data-kind="' + esc(n.kind) + '" tabindex="0">' +
      meta +
      snippetBlock(n) +
      '<div class="say" data-act="reveal" title="Open in the editor">' + esc(n.body) + '</div>' +
      shotsOf(n, false) +
      claudeBlock(n, state === 'rejected') +
      (state === 'rejected' ? rejectionBlock(n) : '') +
      followUp +
      actions +
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
    const stateText =
      s.state === 'working' ? 'Claude is working…' : s.state === 'idle' ? 'watching' : 'not watched';
    const who = s.label ? esc(s.label) : 'No Claude Code session detected';
    const hasRecent = typeof s.changedFiles === 'number' && s.changedFiles > 0;
    // Held until the agent is free. Nothing else says so once the status-bar message is gone,
    // and the notes look simply unsent.
    const queued = s.queued
      ? '<span class="queued" title="They go the moment Claude finishes">' +
        icon('clock') +
        ' ' +
        s.queued +
        ' queued<button data-global="redline.cancelQueued" title="Do not send them automatically">' +
        icon('close') +
        '</button></span>'
      : '';
    // "could not read the file list" must not look like "nothing changed".
    if (s.changesUnavailable) {
      return (
        '<div class="session ' +
        esc(s.state || 'off') +
        '">' +
        '<span class="info" title="Open the log to see why"><span class="dot"></span>' +
        '<span class="who">' +
        who +
        '</span><span class="meta">changes unavailable</span></span>' +
        '<span class="controls">' +
        '<button data-global="redline.showLog" title="Show the log">Log</button>' +
        '<button data-global="redline.pickSession" title="Choose Claude Code session">' + icon('arrow-swap') + '</button>' +
        '</span></div>'
      );
    }
    const changed = hasRecent
      ? '<span class="meta" title="' +
        esc(String(s.changedFiles) + ' files changed ' + (s.rangeLabel || '')) +
        '">' +
        s.changedFiles +
        ' file' +
        (s.changedFiles === 1 ? '' : 's') +
        ' changed' +
        (s.rangeLabel ? ' ' + esc(s.rangeLabel) : '') +
        (s.olderCount ? ' · +' + s.olderCount + ' older' : '') +
        '</span>'
      : '';
    // "Last" and "All" name the same thing at two scopes; "Review" next to "All" read as
    // a different kind of action.
    // "All" is offered whenever anything differs from the base, not only when it would
    // show *more* than "Last": it is the escape hatch when the last-run range looks wrong.
    const hasAny = typeof s.totalFiles === 'number' && s.totalFiles > 0;
    const review =
      (hasRecent
        ? '<button data-global="redline.reviewChanges" title="Diff the last run — ' +
          esc(String(s.changedFiles)) +
          ' file(s)">Last</button>'
        : '') +
      (hasAny
        ? '<button data-global="redline.reviewAllChanges" title="Diff every change since the base — ' +
          esc(String(s.totalFiles)) +
          ' file(s)">All</button>'
        : '');
    return (
      '<div class="session ' +
      esc(s.state || 'off') +
      '">' +
      '<span class="info" title="' +
      who +
      ' — ' +
      stateText +
      '">' +
      '<span class="dot"></span>' +
      '<span class="who">' +
      who +
      '</span>' +
      '<span class="meta">' +
      stateText +
      '</span>' +
      changed +
      queued +
      '</span>' +
      '<span class="controls">' +
      review +
      '<button data-global="redline.pickSession" title="Choose Claude Code session">' + icon('arrow-swap') + '</button>' +
      '</span>' +
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

  function bucket(n) {
    if (n.done || (n.sent && n.sent.outcome === 'done' && !n.pendingReply)) return 'done';
    if (n.sent && (n.sent.outcome || n.sent.changed) && !n.pendingReply) return 'answered';
    return 'waiting';
  }

  function keep(n) {
    return filter === 'all' || bucket(n) === filter;
  }

  function filterBar(counts, total) {
    // Only worth the room once there is enough to lose something in.
    if (total < 6) return '';
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
    let html = sessionStrip();
    const all = (state.cards || []).concat(state.sent || []);
    if (all.length === 0) {
      html +=
        '<div class="empty">No review notes yet.<br><br>Hover a line in the editor and click the ➕ in the gutter, or select lines and press ⌘⌥M / Ctrl+Alt+M.<br><br>Screenshots: paste with ⌘V onto a note, click 📎, or hold ⇧ while dragging the image onto a card.</div>';
      paint(html);
      return;
    }
    const counts = {};
    for (let i = 0; i < all.length; i++) {
      const b = bucket(all[i]);
      counts[b] = (counts[b] || 0) + 1;
    }
    // A filter that hides everything is a dead end, so it gives way rather than showing a
    // blank panel — the chip stays lit so it is obvious what happened.
    if (filter !== 'all' && !(counts[filter] > 0)) filter = 'all';
    html += filterBar(counts, all.length);

    // One column, no file headers: the cards come from all over a change, so a header was
    // mostly one card each, and every card names its own file.
    html += '<div class="list">' + all.filter(keep).map(card).join('') + '</div>';
    paint(html);
  }

  /**
   * Write the panel, but only when it would actually differ.
   *
   * Every store change re-renders, and a store change happens for things that do not touch
   * this markup at all — a run finishing, a note's hash being refreshed, the range being
   * recomputed. Rebuilding identical HTML re-parses every card, drops the scroll position and
   * loses any text selection, which is what made the panel feel like it was flickering while
   * Claude worked.
   */
  var painted = '';
  function paint(html) {
    if (html === painted) return;
    painted = html;
    // Not every host gives us a scrolling element — guard rather than assume, since throwing
    // here would take the whole panel down.
    var scroller = document.scrollingElement || document.documentElement;
    var top = scroller ? scroller.scrollTop : 0;
    root.innerHTML = html;
    // Restoring unconditionally would fight a deliberate scroll-to-top; only put it back when
    // the content is still tall enough for the old position to mean anything.
    if (scroller && top > 0 && scroller.scrollHeight > scroller.clientHeight + top) {
      scroller.scrollTop = top;
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
    popup.innerHTML = html;
    popup.addEventListener('click', (ev) => {
      onPick(ev);
      closePopup();
    });
    document.body.appendChild(popup);
    const r = anchor.getBoundingClientRect();
    popup.style.left = Math.max(4, Math.min(r.left, window.innerWidth - popup.offsetWidth - 8)) + 'px';
    popup.style.top =
      Math.min(r.bottom + window.scrollY + 2, window.scrollY + window.innerHeight - popup.offsetHeight - 8) +
      'px';
  }

  /** Actions that run git, `ps` or the Orca CLI, and so take long enough to show. */
  const SLOW_ACTS = new Set(['send', 'revise', 'attach']);

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
        // The box is already on a card that needs approval; on any other, this reveals it.
        cardEl.classList.add('replying');
        const ta = cardEl.querySelector('textarea');
        if (ta && ta.focus) ta.focus();
        break;
      }
      case 'expand':
        // A settled card keeps what was said; it just does not spend the room on it until
        // someone wants to read it back.
        cardEl.classList.toggle('open');
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

  root.addEventListener('keydown', (e) => {
    const ta = e.target.closest('textarea');
    if (ta && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      const cardEl = ta.closest('.card');
      if (ta.value.trim()) post({ type: 'addAddendum', id: cardEl.dataset.id, text: ta.value });
      ta.value = '';
      cardEl.classList.remove('replying');
    }
  });

  // Apply any render that was deferred while a follow-up was being typed.
  root.addEventListener('focusout', flushPendingRender);

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
      state.kinds = msg.kinds || state.kinds;
      ready = true;
      scheduleRender();
    } else if (msg.type === 'activity') {
      activity = msg.activity || null;
      scheduleRender();
    } else if (msg.type === 'idle') {
      // The extension finished whatever the last click started.
      clearBusy();
    } else if (msg.type === 'session') {
      clearBusy();
      state.session = msg.session || null;
      if (ready) scheduleRender();
    }
  });

  post({ type: 'ready' });
})();
