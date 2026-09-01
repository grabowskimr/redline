/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'node:assert/strict';
import { element, harness, Harness } from './support/panelHarness';

/** One card, in every state it can be in. */

describe('what state a card is in', () => {
  /*
   * These three used to assert against `settled()` and `dimmed()` — two functions defined in
   * this file, three lines above the tests that called them. `cards.js` was never loaded, so
   * every rule they described could be rewritten without a failure, and one of them asserted
   * the opposite of what ships: a done card is *not* faded, it is collapsed to a single row
   * (see "marks the state on the card rather than fading it" below).
   *
   * They now go through the real renderer, like the rest of this file.
   */
  const render = (note: Record<string, unknown>): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [{ kind: 'comment', kindIcon: 'comment', kindLabel: 'change request', kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, id: 'n1', seq: 1, body: 'x', ...note }],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  it('collapses a note you have settled, down to a row you can reopen', () => {
    const html = render({ done: true, sent: { outcome: 'done' } });
    assert.match(html, /class="card done/, 'wears the settled state');
    assert.match(html, /data-act="reopen"/, 'and the one action a finished note still offers');
    assert.match(html, /class="state done">Done</, 'said in a word, not by fading the card');
  });

  it('keeps a settled note settled even with a reply written on it', () => {
    /*
     * `done` wins over everything in `cardState`, deliberately: settling a note is a decision,
     * and a follow-up typed afterwards does not silently undo it. The reply is not lost — the
     * store hands it back when the note is reopened — it is just not offered from here.
     *
     * The test that used to stand here asserted the opposite, and could not fail: it called a
     * `settled()` written in this file rather than the card.
     */
    const html = render({ done: true, sent: { outcome: 'done' }, pendingReply: true });
    assert.match(html, /class="card done/);
    assert.match(html, /class="state done">Done</);
  });

  it('says a note is sent while Claude has it and has not answered', () => {
    const html = render({ sent: { changed: false } });
    assert.doesNotMatch(html, /class="card done/);
    assert.match(html, /class="state waiting">Sent</);
  });
});

describe('a card', () => {
  /** Drives the real `card()` through the DOM shim, one card at a time. */
  const render = (note: Record<string, unknown>): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [{ kind: 'comment', kindIcon: 'comment', kindLabel: 'change request', kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, ...note }],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  const answered = (text: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'n1',
    seq: 1,
    body: 'remove this comment',
    snippet: '// test comment',
    addenda: [`Claude: ${text}`],
    sent: { changed: true, outcome: 'done' },
    ...over,
  });

  it('names its own file, since the cards come from all over', () => {
    // There is no group header above them any more: one header per card was a row of chrome
    // for nothing.
    const html = render({ id: 'n1', seq: 1, body: 'x', fileRef: 'SurveyList.tsx:10' });
    assert.match(html, /SurveyList\.tsx:10/);
    assert.doesNotMatch(html, /class="file"/, 'no group header');
  });

  it('folds a long snippet, and says how much is under the fold', () => {
    /*
     * A note on a whole function is ordinary, and thirty lines of it at the top of a card push
     * everything that needs answering off the screen.
     */
    const code = Array.from({ length: 12 }, (_, i) => `  const line${i} = ${i};`).join('\n');
    const html = render({ id: 'n1', seq: 1, body: 'x', snippet: code, firstLine: 40 });
    assert.match(html, /class="snipwrap clipped"/);
    assert.match(html, /data-act="unclip"[^>]*>Show all 12 lines</);
    // Folded, not truncated: the code is all there, so opening it is a class and not a round
    // trip to the extension for the rest.
    assert.match(html, /const line11 = 11;/);
  });

  it('leaves a short snippet alone', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', snippet: 'const a = 1;\nconst b = 2;' });
    assert.doesNotMatch(html, /snipwrap/);
    assert.doesNotMatch(html, /data-act="unclip"/);
  });

  it('keeps a snippet open across a repaint', () => {
    /*
     * Which cards are open is the panel's own state, and the panel repaints by replacing its
     * markup — so a class on the element is gone the next time the note changes, which while
     * an agent is working is constantly. It used to fold itself back up mid-read.
     */
    const h = harness();
    const card = {
      id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
      fileRef: 'a.ts:1', firstLine: 1, body: 'x',
      snippet: Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n'),
    };
    h.fire('message', { data: { type: 'notes', cards: [card], sent: [], kinds: [] } });
    assert.match(h.root.innerHTML, /snipwrap clipped/, 'folded to begin with');

    const cardEl = h.card('n1');
    const btn: any = {
      tagName: 'BUTTON',
      dataset: { act: 'unclip' },
      classList: { contains: () => false, add: () => undefined, remove: () => undefined },
      closest: (sel: string) => (sel.includes('data-act') ? btn : sel.includes('card') ? cardEl : null),
    };
    h.fire('click', { target: btn, preventDefault: () => undefined });
    assert.doesNotMatch(h.root.innerHTML, /snipwrap clipped/, 'opened');
    assert.match(h.root.innerHTML, />Show less</);

    // Anything at all changing about the note used to fold it again.
    h.fire('message', { data: { type: 'notes', cards: [{ ...card, body: 'x, edited' }], sent: [], kinds: [] } });
    assert.doesNotMatch(h.root.innerHTML, /snipwrap clipped/, 'and stays open');
  });

  it('shows the lines it was written about, numbered from where they are', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', snippet: 'const a = 1;\nconst b = 2;', firstLine: 10 });
    assert.match(html, /class="snip"/);
    assert.match(html, /class="ln">10<\/span>const a = 1;/);
    assert.match(html, /class="ln">11<\/span>const b = 2;/);
  });

  it('says Drafting and offers Attach and Send before it has been sent', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x' });
    assert.match(html, /class="state drafting">/);
    assert.match(html, /data-act="send"[^>]*>Send to Claude</);
    // A word, not a paperclip nobody could make out at that size.
    assert.match(html, /data-act="attach"[^>]*>Attach</);
    assert.doesNotMatch(html, /class="go wide"/, 'and neither button eats the row');
    assert.doesNotMatch(html, /data-act="approve"/);
  });

  it('offers Send while a reply is being written, and hides the verdict buttons', () => {
    // Approve and Not this are about the answer you were given; beside a half-written reply
    // they are noise, and the reply itself needed two presses to go — one to record it and
    // one to send. Both rows are rendered and the card shows one.
    const html = render(answered('Removed it.'));
    assert.match(html, /class="answering"/);
    assert.match(html, /class="actions composing"/);
    assert.match(html, /data-act="send-now"[^>]*>Send</);
    assert.doesNotMatch(html, /Send your reply/, 'one row, not a near-identical second one');
  });

  it('says a card is holding rather than looking as though the button did nothing', () => {
    // Sending while the agent is working queues the note. Nothing about the note changes, so
    // without this the card looked exactly as it did before the click.
    const html = render({ id: 'n1', seq: 1, body: 'x', queued: true, pendingReply: true });
    assert.match(html, /Queued — goes when Claude finishes/);
    assert.match(html, /data-act="unqueue"/, 'and this one can be called off on its own');
    assert.doesNotMatch(html, /data-act="send"/, 'nothing to press twice');
  });

  it('keeps the follow-up box shut until Reply asks for it', () => {
    // It sat open under every card that needed an answer, above the buttons — so the first
    // thing a card asked for was typing, when the usual answer is one of the three buttons
    // beneath it. Rendered either way, so a repaint cannot lose what is half-written in it.
    const html = render(answered('Removed it.'));
    assert.match(html, /class="block follow compose"/, 'rendered');
    assert.doesNotMatch(html, /class="card approve replying"/, 'and shut');
    assert.match(html, /data-act="cancel-reply"/, 'with a way out of it once it is open');
  });

  it('says Needs approval and offers the three answers once Claude has changed something', () => {
    const html = render(answered('Removed the trailing comment.'));
    assert.match(html, />Needs approval</);
    assert.match(html, /Claude&#39;s change|Claude's change/);
    assert.match(html, /Removed the trailing comment\./);
    assert.match(html, /data-act="approve"[^>]*>Approve</);
    assert.match(html, /data-act="needswork"[^>]*>Not this</);
    assert.match(html, /data-act="reply"[^>]*>Reply</);
    assert.match(html, /Ask for a change or another attempt/, 'and a box to write the next one in');
    // ⏎ inserts a newline — a follow-up is often several lines — so the hint has to name the
    // key that actually sends, or the first thing a new reader tries does nothing visible.
    assert.match(html, /class="hint"[^>]*>(⌘⏎|Ctrl\+⏎)</);
  });

  it('does not say it is waiting on Claude when Claude never got it', () => {
    // With no session to type into, the batch goes to the clipboard and nobody has read it.
    // The card said "Waiting for Claude…" over it — a lie about where the work is, and about
    // whose turn it is, on the one screen that exists to answer both.
    const html = render({
      id: 'n1', seq: 1, body: 'x',
      awaiting: true,
      sent: { changed: false, route: 'clipboard' },
    });
    assert.doesNotMatch(html, /Waiting for Claude/);
    assert.match(html, /On your clipboard — paste it into Claude Code/);
    assert.match(html, />On your clipboard</, 'and the state word says so too');
  });

  it('says a staged batch is waiting on you, not on Claude', () => {
    const html = render({
      id: 'n1', seq: 1, body: 'x',
      awaiting: true,
      sent: { changed: false, route: 'staged' },
    });
    assert.doesNotMatch(html, /Waiting for Claude/);
    assert.match(html, /type the delivery word in your session/);
  });

  it('still says it is waiting on Claude when Claude actually got it', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', awaiting: true, sent: { changed: false } });
    assert.match(html, /Waiting for Claude…/);
    assert.match(html, />Sent</);
    /*
     * And a way out of waiting. Nothing brings an answer back on its own without the plugin,
     * or an Orca session being watched — so on a plain VS Code terminal this card could sit
     * here for ever with no buttons on it at all, and the only exits were the ⋯ menu and a
     * command in the danger group, neither of them named for the situation.
     */
    assert.match(html, /data-global="redline\.applyReport"[^>]*>Read the reply</);
  });

  it('does not say it is waiting on Claude once Claude has answered', () => {
    // Claude replying "the note just says test, so I left it alone — say what you want
    // changed" is an outcome with no code change behind it. It matched no branch: the card
    // printed the answer and, under it, "Waiting for Claude…" about a finished turn.
    const html = render(
      answered('The comment is just "test", so I left it untouched — say what you want changed.', {
        sent: { changed: false, outcome: 'answered' },
      }),
    );
    assert.doesNotMatch(html, /Waiting for Claude/);
    assert.match(html, />Needs approval</, 'it is waiting on the reader');
    assert.match(html, /data-act="approve"/, 'and can be settled');
  });

  it('calls it an answer, not a change, when nothing was changed', () => {
    const html = render(answered('Skipped — the note reads only "test".', { sent: { changed: false, outcome: 'answered' } }));
    assert.match(html, /Claude&#39;s answer|Claude's answer/);
  });

  it('strips the speaker prefix rather than printing it', () => {
    const html = render(answered('Removed it.'));
    assert.doesNotMatch(html, /Claude: Removed it/);
    assert.match(html, /Removed it\./);
  });

  it('dims the answer that was turned down and keeps the reason beside it', () => {
    const html = render(
      answered('Skipped — the note reads only "test".', {
        rejected: true,
        pendingReply: true,
        addenda: ['Claude: Skipped — the note reads only "test".', 'I wanted an explanation, not an edit.'],
      }),
    );
    assert.match(html, />Rejected</);
    assert.match(html, /class="block claude dim"/, 'still readable, no longer the live thing');
    assert.match(html, /You · rejected|You &#183; rejected/);
    assert.match(html, /I wanted an explanation, not an edit\./);
    assert.match(html, /class="card rejected replying"/, 'the box is open on what is written');
    assert.match(html, /data-act="send-now"[^>]*>Send</, 'the reason still has to be sent');
    // The state's own row is rendered *and shown*: a rejected card is the one case where the
    // reply box and the state's buttons belong on screen together, because *Keep it* is an
    // answer to the same question the box is asking. Hiding it behind `replying` left a
    // rejected card with a box and no way to change your mind.
    assert.match(html, /class="answering"/);
  });

  it('never leaves a rejected card without a way forward, with or without a report', () => {
    /*
     * Without the plugin there is no report, so a note keeps `awaiting` after it is turned
     * down — and the waiting branch matched first, showing "Claude is having another go…" over
     * a rejection that had gone nowhere, with no buttons at all. A dead end and a false
     * sentence, on the path most users are on.
     */
    const html = render(
      answered('Renamed it.', { rejected: true, awaiting: true, sent: { changed: true } }),
    );
    assert.doesNotMatch(html, /having another go/, 'nothing has been sent');
    assert.match(html, /Say what was wrong/);
    assert.match(html, /data-act="reply"[^>]*>Write it</);
    assert.match(html, /data-act="approve"[^>]*>Keep it</);
  });

  it('asks for the reason before it claims Claude is doing anything', () => {
    // Turning a change down said "Claude is working on it…" straight away. Nothing had been
    // sent: the rejection does not go anywhere until you say what was wrong, and there was no
    // button to send it with either.
    const html = render(answered('Renamed it.', { rejected: true }));
    assert.match(html, /Say what was wrong/);
    assert.doesNotMatch(html, /working on it/, 'nobody is working on anything yet');
    assert.match(html, /class="ask"/, 'and the box to write it in is on the card');
    // The box is behind Reply now, so this row has to be able to open it — otherwise a repaint
    // leaves the card asking for a reason with nothing on it that takes one.
    assert.match(html, /data-act="reply"[^>]*>Write it</, 'a way to open it');
    assert.match(html, /data-act="approve"[^>]*>Keep it</, 'and a way back out of a misclick');
  });

  it('says another attempt is under way once the reason has gone', () => {
    const html = render(
      answered('Renamed it.', {
        rejected: true,
        awaiting: true,
        addenda: ['Claude: Renamed it.', 'not that one'],
      }),
    );
    assert.match(html, /Claude is having another go…/);
  });

  it('collapses to a single line once it is settled', () => {
    // Even the code goes behind the click. A settled card is a line in a list until someone
    // wants to read it back — twenty of them with their snippets showing is the whole panel.
    const html = render(answered('Renamed it.', { done: true, body: 'rename prop to isPending', snippet: 'const a = 1;' }));
    assert.match(html, /class="card done"/);
    assert.match(html, /class="summary"/);
    assert.match(html, /rename prop to isPending/);
    assert.match(html, /class="folded"/, 'and the exchange is still there to open');
    assert.ok(
      html.indexOf('class="folded"') < html.indexOf('class="snip"'),
      'the snippet is inside the fold, not above it',
    );
  });

  it('offers to take a settled note off the list, and to pick it up again', () => {
    // Approving is not the end of the conversation if something occurs to you afterwards.
    const html = render(answered('Renamed it.', { done: true, body: 'rename prop' }));
    assert.match(html, /data-act="remove"/, 'removable without going through the ⋯ menu');
    assert.match(html, /data-act="reopen"[^>]*>.*Pick this up again/, 'and reopenable');
  });

  it('marks the state on the card rather than fading it', () => {
    // Dimming a whole card makes it unreadable to say something a word says better.
    const html = render(answered('Renamed it.', { done: true }));
    assert.doesNotMatch(html, /opacity/);
  });

  it('uses a coloured codicon for the kind, and no emoji anywhere', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', kind: 'bug', kindIcon: 'bug', kindLabel: 'bug', kindColor: '#e08d8d' });
    assert.match(html, /class="codicon codicon-bug"/);
    // The colour comes from a class, not a `style` attribute: the panel's CSP has no
    // `'unsafe-inline'` for styles, so every one of those was dropped without a word.
    assert.match(html, /class="kind k-bug"/, 'the colour is a class the policy keeps');
    assert.doesNotMatch(html, /style="/, 'nothing the policy will throw away');
    assert.match(html, /title="Change kind — bug"/, 'the name is in the tooltip, not on the card');
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');
  });

  it('shows the follow-up you wrote, and offers to send it', () => {
    // It went into the store and appeared nowhere: the card looked as though the words had
    // been thrown away, and the only sign anything had happened was the button changing.
    const html = render(
      answered('Removed it.', {
        pendingReply: true,
        addenda: ['Claude: Removed it.', 'not quite — the other one too'],
        sent: { changed: true, outcome: 'done', seenTurns: 1 },
      }),
    );
    assert.match(html, /not quite — the other one too/, 'your words are on the card');
    assert.match(html, /You · follow-up|You &#183; follow-up/);
    assert.match(html, /not sent yet/, 'and marked as unsent');
    assert.match(html, /data-act="send-now"[^>]*>Send</);
    assert.ok(
      html.indexOf('Removed it.') < html.indexOf('not quite'),
      'in the order the conversation happened',
    );
  });

  it('offers to take back a follow-up that has not gone, and only that one', () => {
    // Written in haste, or into the wrong card. Once Claude has read it, it is part of the
    // record and taking it back would leave the answer replying to nothing.
    const html = render(
      answered('Removed it.', {
        pendingReply: true,
        addenda: ['Claude: Removed it.', 'sent already', 'not sent yet at all'],
        sent: { changed: true, outcome: 'done', seenTurns: 2 },
      }),
    );
    const undo = [...html.matchAll(/data-act="undo-turn" data-turn="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(undo, ['2'], 'only the turn Claude has not seen');
  });

  it('keeps the whole exchange, not just the newest turn', () => {
    const html = render(
      answered('First attempt.', {
        addenda: ['Claude: First attempt.', 'try again', 'Claude: Second attempt.'],
        sent: { changed: true, outcome: 'done', seenTurns: 3 },
      }),
    );
    for (const turn of ['First attempt.', 'try again', 'Second attempt.']) {
      assert.match(html, new RegExp(turn.replace('.', '\\.')), `${turn} is on the card`);
    }
    assert.doesNotMatch(html, /not sent yet/, 'all of it has gone');
  });

  it('carries the kind on one mark, beside the file, and not twice', () => {
    // It was a coloured dot beside the state as well — and being an inline `style` the CSP
    // threw away, it drew as a six-pixel hole in the padding, which is what gave it away. One
    // icon in the kind's colour says the same thing without indenting the state word.
    const html = render({ id: 'n1', seq: 1, body: 'x', kind: 'bug', kindLabel: 'bug' });
    assert.match(html, /class="kind k-bug"/);
    assert.doesNotMatch(html, /class="dot k-/, 'not a second mark for the same thing');
  });

  it('opens on a reply that was written and never sent', () => {
    // Reachable when a settled note is picked up again: its unsent turn is owed once more.
    // The card starts with the box open rather than growing a second row of its own that says
    // the same thing as the first.
    const html = render(answered('Done.', { pendingReply: true, addenda: ['Claude: Done.', 'not quite'] }));
    assert.match(html, /class="card \w+ replying"/);
    assert.match(html, /data-act="send-now"[^>]*>Send</);
    // It said "Sent", which is the one thing a reply sitting in your hands is not.
    assert.match(html, />Reply not sent</);
    assert.doesNotMatch(html, />Sent</);
  });

  it('says the file is gone, and stops offering to open it', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', missing: true });
    assert.match(html, /class="ref gone"/);
  });

  it('marks a note whose lines have moved out from under it', () => {
    const html = render({ id: 'n1', seq: 1, body: 'x', orphaned: true });
    assert.match(html, /class="ref stale"/);
    assert.match(html, /may be wrong/);
  });

  it('offers to re-anchor a stale note, and only a stale one', () => {
    // The card said the note had lost its lines and gave no way to act on it: the command
    // existed, was documented, and reached no menu anywhere.
    const h = harness();
    const open = (note: Record<string, unknown>): string[] => {
      h.fire('message', {
        data: {
          type: 'notes',
          cards: [{ id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
            kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, body: 'x', ...note }],
          sent: [],
          kinds: [],
        },
      });
      const card = h.card('n1');
      const btn: any = { tagName: 'BUTTON', dataset: { act: 'more' }, classList: { contains: () => false, add() {}, remove() {} },
        getBoundingClientRect: () => ({ left: 0, bottom: 0 }), parentCard: card, closest: (sel: string) =>
          sel.includes('data-act') ? btn : sel.includes('card') ? card : null };
      h.fire('click', { target: btn, preventDefault: () => undefined, stopPropagation: () => undefined });
      return [...h.menuHtml.matchAll(/data-menu-act="([^"]+)"/g)].map((m) => m[1] ?? '');
    };
    assert.ok(open({ orphaned: true }).includes('reanchor'), 'offered when the lines are gone');
    assert.ok(!open({}).includes('reanchor'), 'and not when they are not');
  });

  it('names a screenshot and says what it is attached to', () => {
    // A path is not a thing you recognise after the fact, and both kinds of attachment are
    // paths — which turn one belongs to cannot be recovered from it.
    const html = render({
      id: 'n1', seq: 1, body: 'x',
      attachments: [{ src: 'vscode://x/a.png', path: '/tmp/a.png', name: 'panel-spacing.png', caption: 'attached screenshot', turn: 0 }],
    });
    assert.match(html, /panel-spacing\.png/);
    assert.match(html, /attached screenshot/);
    assert.match(html, /data-shot="\/tmp\/a\.png"/);
    assert.match(html, /data-unshot="\/tmp\/a\.png"/, 'removable while the note is live');
  });

  it('puts a screenshot beside the turn it was taken for, not at the foot of the card', () => {
    // It records how many turns preceded it. Filed under "a follow-up" it landed under the
    // newest one, so a picture taken for the first follow-up ended up illustrating the last.
    const html = render({
      id: 'n1', seq: 1, body: 'why is this here?',
      addenda: ['Claude: Skipped.', 'this is what I meant', 'Claude: Changed it.', 'still not it'],
      sent: { changed: true, outcome: 'done', seenTurns: 4 },
      attachments: [
        { src: 'vscode://x/b.png', path: '/tmp/b.png', name: 'expected-memo.png', caption: 'attached to this follow-up', turn: 2 },
      ],
    });
    assert.match(html, /expected-memo\.png/);
    assert.ok(
      html.indexOf('this is what I meant') < html.indexOf('expected-memo'),
      'below the follow-up it belongs to',
    );
    assert.ok(
      html.indexOf('expected-memo') < html.indexOf('Changed it.'),
      'and above the answer that came after it',
    );
    assert.doesNotMatch(html, /data-unshot/, 'already sent — nothing to take back');
  });

  it('keeps the note\'s own screenshot out of the first follow-up\'s block', () => {
    // Both are attached with `addenda` empty, so a bare count gave them the same number and
    // the card drew the note's picture twice — once under the note, once inside the follow-up.
    const html = render({
      id: 'n1', seq: 1, body: 'x',
      addenda: ['Claude: done', 'and this too'],
      sent: { changed: true, outcome: 'done', seenTurns: 2 },
      attachments: [
        { src: 'vscode://x/a.png', path: '/tmp/a.png', name: 'the-note.png', caption: 'attached screenshot', turn: 0 },
      ],
    });
    assert.equal(html.split('data-shot="/tmp/a.png"').length - 1, 1, 'drawn once, in one place');
    assert.ok(html.indexOf('the-note.png') < html.indexOf('Claude'), 'above the exchange');
  });

  it('holds a screenshot with the box until the follow-up it was taken for is written', () => {
    const html = render({
      id: 'n1', seq: 1, body: 'x',
      addenda: ['Claude: done'],
      sent: { changed: true, outcome: 'done', seenTurns: 1 },
      attachments: [
        { src: 'vscode://x/c.png', path: '/tmp/c.png', name: 'wanted.png', caption: 'attached to this follow-up', turn: 2 },
      ],
    });
    assert.ok(html.indexOf('done') < html.indexOf('wanted.png'), 'after the last turn');
    assert.match(html, /data-unshot="\/tmp\/c\.png"/, 'and still removable');
  });

  it('offers to attach one before the note goes, and from the follow-up box', () => {
    assert.match(render({ id: 'n1', seq: 1, body: 'x' }), /data-act="attach"[^>]*>.*Attach/);
    const waiting = render({
      id: 'n1', seq: 1, body: 'x', sent: { changed: true, outcome: 'done' }, addenda: ['Claude: done'],
    });
    assert.match(waiting, /class="clip" data-act="attach"/);
  });

  it('keeps delete and copy in the overflow, off the card face', () => {
    // Three buttons is the tightest row that fits 420px; a fourth would wrap, and a wrapped
    // verb stops reading as a button.
    assert.match(render({ id: 'n1', seq: 1, body: 'x' }), /data-act="more"/);
  });
});

describe('rendering what Claude wrote', () => {
  const withReply = (text: string): string => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [
          {
            id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
            kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, body: 'x',
            addenda: [`Claude: ${text}`], sent: { changed: true, outcome: 'done' },
          },
        ],
        sent: [],
        kinds: [],
      },
    });
    return h.root.innerHTML;
  };

  it('turns a markdown link into one clickable reference', () => {
    const html = withReply('Removed it in [Question.tsx:35](src/Question.tsx).');
    assert.match(html, /data-open="src\/Question\.tsx"/);
    assert.match(html, /Question\.tsx:35/);
    assert.doesNotMatch(html, /\]\(/, 'no raw markdown left');
  });

  it('renders backticked code as code', () => {
    assert.match(withReply('Removed the `// test comment` line.'), /<code>\/\/ test comment<\/code>/);
  });

  it('escapes before it renders, so markup in the text stays text', () => {
    const html = withReply('Wrapped it in <script>alert(1)</script> tags.');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('committing a follow-up', () => {
  const cardWithBox = (): { h: Harness; ta: any } => {
    const h = harness();
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [{
          id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
          kindColor: '#e0894a', fileRef: 'a.ts:1', firstLine: 1, body: 'x',
          addenda: ['Claude: done'], sent: { changed: true, outcome: 'done', seenTurns: 1 },
        }],
        sent: [],
        kinds: [],
      },
    });
    const ta = element('textarea');
    ta.value = 'not quite';
    const card = h.card('n1');
    card.box = ta;
    ta.parentCard = card;
    return { h, ta };
  };

  it('lets go of the box once the reply has gone', () => {
    // A repaint carries a focused box across, cursor and all — right while you are typing and
    // wrong the instant you are not. A box that had just been emptied and handed off read as
    // one being typed in, so the repaint put the card back into `replying` and hid the
    // "Sending…" row behind an empty box with no buttons under it.
    const { h, ta } = cardWithBox();
    let blurred = false;
    ta.blur = () => {
      blurred = true;
    };
    h.fire('keydown', { target: ta, key: 'Enter', metaKey: true, preventDefault() {} });
    assert.ok(
      h.posted.some((p: any) => p.type === 'addAddendum' && p.text === 'not quite'),
      'the turn was sent to the extension',
    );
    assert.equal(blurred, true, 'and the box is no longer being typed in');
  });

  it('takes what is in the box when Reply is clicked a second time', () => {
    // The first press opens the box. Pressing it again on words you have just typed used to do
    // nothing at all: it only moved focus to where the cursor already was.
    const { h, ta } = cardWithBox();
    const card = h.cards[h.cards.length - 1];
    const open = new Set<string>(['replying']);
    const btn: any = {
      tagName: 'BUTTON',
      dataset: { act: 'reply' },
      classList: { contains: () => false, add: () => undefined, remove: () => undefined },
      closest: (sel: string) => (sel.includes('data-act') ? btn : sel.includes('card') ? card : null),
    };
    card.classList = {
      contains: (c: string) => open.has(c),
      add: (c: string) => open.add(c),
      remove: (c: string) => open.delete(c),
    };
    h.fire('click', { target: btn, preventDefault: () => undefined });
    assert.ok(
      h.posted.some((p: any) => p.type === 'addAddendum' && p.text === 'not quite'),
      'the follow-up was taken',
    );
    assert.equal(ta.value, '', 'and the box is clear for the next one');
  });

  it('reveals and focuses the box when Reply is clicked with nothing written', () => {
    const { h, ta } = cardWithBox();
    ta.value = '';
    let focused = false;
    ta.focus = () => {
      focused = true;
    };
    const card = h.cards[h.cards.length - 1];
    const btn: any = {
      tagName: 'BUTTON',
      dataset: { act: 'reply' },
      classList: { contains: () => false, add: () => undefined, remove: () => undefined },
      closest: (sel: string) => (sel.includes('data-act') ? btn : sel.includes('card') ? card : null),
    };
    h.fire('click', { target: btn, preventDefault: () => undefined });
    assert.equal(h.posted.filter((p: any) => p.type === 'addAddendum').length, 0, 'nothing to take');
    assert.equal(focused, true, 'so it puts the cursor where the words go');
  });

  it('sends on ⌘⏎, the same as pressing Send', () => {
    // It only recorded the turn, so the shortcut and the button beside it did different
    // things — and the shortcut left the reply sitting on the card needing a second press
    // that the hint next to it said nothing about.
    const { h, ta } = cardWithBox();
    h.fire('keydown', { target: ta, key: 'Enter', metaKey: true, preventDefault() {} });
    assert.ok(
      h.posted.some((p: any) => p.type === 'addAddendum' && p.text === 'not quite'),
      'the turn is recorded',
    );
    assert.ok(
      h.posted.some((p: any) => p.type === 'command' && p.command === 'redline.sendSelected'),
      'and sent, without a second press',
    );
  });

  it('says the card is sending, instead of flashing the verdict buttons at you', () => {
    /*
     * Sending is three things in a row — record the turn, hand it to the extension, hear back
     * — and each one repaints. In between, the card fell back to *Approve · Not this · Reply*
     * for a frame, which is the one row that is certainly wrong at that moment: the answer is
     * already on its way.
     */
    const { h, ta } = cardWithBox();
    h.fire('keydown', { target: ta, key: 'Enter', metaKey: true, preventDefault() {} });
    assert.match(h.root.innerHTML, /Sending…/);
    assert.doesNotMatch(h.root.innerHTML, /data-act="approve"/, 'nothing to approve mid-flight');
    assert.doesNotMatch(h.root.innerHTML, /data-act="send-now"/, 'and nothing to press again');

    // It holds until the note itself says where it went, however many repaints that takes.
    h.fire('message', {
      data: {
        type: 'notes',
        cards: [{ id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
          fileRef: 'a.ts:1', firstLine: 1, body: 'x', pendingReply: true,
          addenda: ['Claude: done', 'not quite'], sent: { changed: true, outcome: 'done', seenTurns: 1 } }],
        sent: [],
        kinds: [],
      },
    });
    assert.match(h.root.innerHTML, /Sending…/, 'still on its way');

    h.fire('message', {
      data: {
        type: 'notes',
        cards: [{ id: 'n1', seq: 1, kind: 'comment', kindIcon: 'comment', kindLabel: 'change request',
          fileRef: 'a.ts:1', firstLine: 1, body: 'x', awaiting: true,
          addenda: ['Claude: done', 'not quite'], sent: { changed: false, seenTurns: 2 } }],
        sent: [],
        kinds: [],
      },
    });
    assert.doesNotMatch(h.root.innerHTML, /Sending…/, 'and lets go once it has landed');
    assert.match(h.root.innerHTML, /Waiting for Claude…/);
  });

  it('sends nothing for an empty box', () => {
    const { h, ta } = cardWithBox();
    ta.value = '   ';
    ta.blur = () => undefined;
    h.fire('keydown', { target: ta, key: 'Enter', metaKey: true, preventDefault() {} });
    assert.equal(h.posted.filter((p: any) => p.type === 'addAddendum').length, 0);
  });
});
