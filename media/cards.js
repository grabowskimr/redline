/* Review Notes panel. Runs inside the webview; talks to the extension via postMessage.
 * State arrives in two independent messages so slow/failing session lookups can never
 * stop the notes from rendering:
 *   { type: 'notes',   groups, sent, kinds } — cheap, always sent first
 *   { type: 'session', session: … } — best-effort, may never arrive
 */
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  /** @type {{groups: any[], sent: any[], kinds: any[], session: any}} */
  let state = { groups: [], sent: [], kinds: [], session: null };
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
    for (const g of state.groups) {
      for (const n of g.notes) if (n.id === id) return n;
    }
    for (const n of state.sent) if (n.id === id) return n;
    return {};
  }

  // ── rendering ────────────────────────────────────────────────────────

  function statusOf(n) {
    if (!n.sent) return '';
    const o = n.sent.outcome;
    if (o === 'done') return '✅ done';
    if (o === 'skipped') return '⛔ skipped' + (n.sent.reply ? ' — ' + esc(n.sent.reply) : '');
    if (o === 'answered') return '💬 answered';
    return n.sent.changed ? '✏️ code changed' : '⏳ not addressed yet';
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

  function card(n) {
    // Settled: dealt with, and nothing left to read — collapsed, dimmed, and removable in one
    // click rather than through the ⋯ menu. A reply that has not been sent makes it live
    // again: the conversation is waiting on you, not on Claude. Declared first because the
    // screenshot and action markup below both depend on it.
    const settled = !!(n.done || (n.sent && n.sent.outcome)) && !n.pendingReply;

    const beforeAfter = n.after !== undefined && n.after !== null;
    const codeLabel = n.orphaned
      ? 'original code (stale)'
      : esc(n.where) + (n.language ? ' · ' + esc(n.language) : '');
    const snippet = n.snippet
      ? codeBox(
          beforeAfter ? 'before' : '',
          beforeAfter ? 'before (what you reviewed)' : codeLabel,
          n.snippet,
          'reveal',
        )
      : '';
    const after = beforeAfter
      ? codeBox('after', 'after (Claude&#8217;s change · ' + esc(n.where) + ')', n.after, 'reveal')
      : '';
    const sugg =
      n.suggestion !== undefined && n.suggestion !== null
        ? codeBox('suggestion', 'suggested change', n.suggestion, 'suggest')
        : '';
    const addenda = (n.addenda || [])
      .map(
        (a) =>
          '<div class="addendum' +
          (String(a).startsWith('Claude:') ? ' agent' : '') +
          '">' +
          esc(a) +
          '</div>',
      )
      .join('');
    const shots = (n.attachments || []).length
      ? '<div class="shots">' +
        n.attachments
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
              // Removable exactly when attaching is offered. Keyed on `sent` alone, a
              // screenshot added to a reply could never be taken off again.
              (settled
                ? ''
                : '<span class="x" data-unshot="' + esc(a.path) + '" title="Remove screenshot">✕</span>') +
              '</span>',
          )
          .join('') +
        '</div>'
      : '';
    const status = n.pendingReply
      ? '✎ follow-up not sent'
      : n.awaiting
      ? '<span class="codicon codicon-loading codicon-modifier-spin"></span> waiting for Claude'
      : n.sent
      ? statusOf(n)
      : n.done
      ? '✓ done'
      : n.orphaned
      ? '⚠ stale'
      : '';
    return (
      '<div class="card' +
      (n.done && !n.pendingReply ? ' done' : '') +
      (settled ? ' settled' : '') +
      (n.pendingReply ? ' pending' : '') +
      (n.awaiting ? ' awaiting' : '') +
      '" data-id="' +
      esc(n.id) +
      '" data-kind="' +
      esc(n.kind) +
      '" tabindex="0">' +
      '<div class="head">' +
      '<span class="seq">#' +
      esc(n.seq) +
      '</span>' +
      '<span class="kind" data-act="kind" title="Change kind">' +
      icon(n.kindIcon) +
      ' ' +
      esc(n.kindLabel) +
      '</span>' +
      '<span class="where" data-act="reveal" title="Open in editor">' +
      esc(n.where) +
      '</span>' +
      '<span class="spacer"></span>' +
      (status ? '<span class="status">' + status + '</span>' : '') +
      '</div>' +
      '<div class="body" data-act="reveal" title="Open in the editor — edit the note in the comment widget there">' +
      esc(n.body) +
      '</div>' +
      // Addenda survive collapsing: an answered note keeps Claude's reply there, and
      // hiding it would throw away the only thing the round produced.
      addenda +
      (settled ? '' : shots + snippet + after + sugg) +
      '<div class="reply"><textarea placeholder="' +
      (n.sent ? 'Follow-up… (⌘⏎ to save, ➤ to send)' : 'Follow-up… (⌘⏎ to save)') +
      '"></textarea></div>' +
      '<div class="actions">' +
      // Reply is always available: it is how a conversation continues, whatever state the
      // note is in. Attaching is available whenever something is still going to be sent,
      // because a reply often needs a screenshot before it goes.
      btn(
        'reply',
        '↳',
        n.sent ? 'Follow-up — continues this conversation with Claude' : 'Follow-up — added before this is sent',
      ) +
      (settled
        ? btn('reopen', '↺', n.done ? 'Reopen this note' : 'Mark as not done')
        : btn(
            'attach',
            '📎',
            'Attach a screenshot: click to pick a file, paste with ⌘V, or hold ⇧ while dragging an image onto this card',
          ) +
          // Reflects the state it is in: offering "mark done" on a note that is already done
          // means the click quietly undoes it, which reads as the button not working.
          (n.done ? btn('reopen', '↺', 'Reopen this note') : btn('done', '✓', 'Mark done'))) +
      (!n.sent || n.pendingReply
        ? btn(
            'send',
            '➤',
            n.pendingReply ? 'Send your reply to Claude Code' : 'Send this note to Claude Code',
            'go',
          )
        : '') +
      '<span class="spacer"></span>' +
      (settled ? btn('remove', '✕', 'Remove this note', 'danger') : '') +
      btn('more', '⋯', 'More actions…') +
      '</div>' +
      '</div>'
    );
  }

  function sessionStrip() {
    const s = state.session;
    if (!s) return '';
    const stateText =
      s.state === 'working' ? 'Claude is working…' : s.state === 'idle' ? 'watching' : 'not watched';
    const who = s.label ? esc(s.label) : 'No Claude Code session detected';
    const hasRecent = typeof s.changedFiles === 'number' && s.changedFiles > 0;
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
        '<button data-global="redline.pickSession" title="Choose Claude Code session">⇄</button>' +
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
      '</span>' +
      '<span class="controls">' +
      review +
      '<button data-global="redline.pickSession" title="Choose Claude Code session">⇄</button>' +
      '</span>' +
      '</div>'
    );
  }

  function render() {
    if (!ready) return;
    let html = sessionStrip();
    if (!state.groups.length && !state.sent.length) {
      html +=
        '<div class="empty">No review notes yet.<br><br>Hover a line in the editor and click the ➕ in the gutter, or select lines and press ⌘⌥M / Ctrl+Alt+M.<br><br>Screenshots: paste with ⌘V onto a note, click 📎, or hold ⇧ while dragging the image onto a card.</div>';
      root.innerHTML = html;
      return;
    }
    for (const g of state.groups) {
      html +=
        '<div class="file"><span class="base">' +
        esc(g.base) +
        '</span><span class="dir" title="' +
        esc(g.path) +
        '">' +
        esc(g.dir) +
        '</span><span class="count">' +
        g.notes.length +
        '</span></div>';
      html += g.notes.map(card).join('');
    }
    if (state.sent.length) {
      const addressed = state.sent.filter((n) => n.sent && (n.sent.outcome || n.sent.changed)).length;
      html += '<h3>Sent to Claude — ' + addressed + '/' + state.sent.length + ' addressed</h3>';
      html +=
        '<div class="sentbar">' +
        '<button data-global="redline.clearSent" title="Archive these and clear the section">✓ clear sent</button>' +
        '</div>';
      html += state.sent.map(card).join('');
    }
    root.innerHTML = html;
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

      case 'suggest':
        cmd('redline.addSuggestion', id);
        break;
      case 'attach':
        post({ type: 'attachPick', id });
        break;
      case 'reply': {
        cardEl.classList.toggle('replying');
        const ta = cardEl.querySelector('textarea');
        if (ta) ta.focus();
        break;
      }
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
        if (!n.sent) {
          items.push([
            'suggest',
            '⇄',
            n.suggestion !== undefined && n.suggestion !== null
              ? 'Edit suggested change'
              : 'Add suggested change',
          ]);
          if (n.suggestion !== undefined && n.suggestion !== null) {
            items.push(['apply', '▶', 'Apply suggestion to the file']);
          }
        }
        items.push(['copy', '⧉', 'Copy this note']);
        items.push(['delete', '🗑', 'Delete note']);
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
            const map = {
              suggest: 'redline.addSuggestion',
              apply: 'redline.applySuggestion',
              copy: 'redline.copyNote',
              delete: 'redline.deleteNote',
            };
            const command = map[mi.dataset.menuAct];
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
      state.groups = msg.groups || [];
      state.sent = msg.sent || [];
      state.kinds = msg.kinds || state.kinds;
      ready = true;
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
