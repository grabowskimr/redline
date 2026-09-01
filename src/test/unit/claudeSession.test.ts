import * as assert from 'node:assert/strict';
import { bracketedPaste, isReachable, SessionTarget } from '../../claude/claudeSession';

const ESC = String.fromCharCode(27);
const OPEN = ESC + '[200~';
const CLOSE = ESC + '[201~';

/**
 * The part of session handling that decides what reaches the agent.
 *
 * Discovery itself shells out to `ps`, `lsof` and the Orca CLI and belongs to the integration
 * suite; these are the decisions made around it, which are where a send quietly goes to the
 * wrong place or arrives mangled.
 */
describe('choosing where a batch goes', () => {
  const target = (over: Partial<SessionTarget> = {}): SessionTarget =>
    ({ key: 'k', label: 'Claude Code', pid: 1, cwd: '/repo', inWorkspace: true, ...over }) as SessionTarget;

  it('counts a session as reachable only when there is something to type into', () => {
    // A Claude process Redline can see but cannot address is worse than none: it looks like a
    // destination and silently is not. The clipboard is the honest answer for those.
    assert.equal(isReachable(target({ terminal: {} as never })), true, 'a VS Code terminal');
    assert.equal(isReachable(target({ orcaHandle: 'orca-1' })), true, 'an Orca terminal');
    assert.equal(isReachable(target()), false, 'seen in the process table and nothing more');
  });
});

describe('typing a prompt into a terminal', () => {
  it('wraps it so the terminal takes it as one paste, not as typing', () => {
    /*
     * Without the markers a terminal reads a multi-line prompt as line after line of typing,
     * and an agent's input box submits on the first newline — so a two-note batch sent the
     * first note and left the rest as stray text.
     */
    const wrapped = bracketedPaste('first\nsecond');
    assert.ok(wrapped.startsWith(OPEN), 'opens a paste');
    assert.ok(wrapped.endsWith(CLOSE), 'and closes it');
  });

  it('sends newlines as carriage returns, which is what a terminal reads', () => {
    assert.equal(bracketedPaste('a\nb'), OPEN + 'a\rb' + CLOSE);
    assert.equal(bracketedPaste('a\r\nb'), OPEN + 'a\rb' + CLOSE, 'however they arrived');
  });

  it('leaves a single line exactly as it was', () => {
    assert.equal(bracketedPaste('just this'), OPEN + 'just this' + CLOSE);
  });

  it('does not mangle the code inside a prompt', () => {
    // Prompts carry code, and code carries backslashes and braces. Only newlines are touched.
    const code = 'const re = /\\d+/g; // {"a": 1}';
    assert.ok(bracketedPaste(code).includes(code));
  });
});

describe('what a paste is not allowed to carry', () => {
  /*
   * A bracketed paste is bounded by two escape sequences, and the payload used to be wrapped
   * without being checked. A file under review containing the literal bytes of the *closing*
   * sequence — invisible in an editor — ended the paste early, and everything after it arrived
   * as live keystrokes. `bracketedPaste` turns every newline into a carriage return, which is
   * Enter: in a Claude Code TUI that submits whatever followed, and in a shell it runs it.
   *
   * Claude's own replies travel in the same payload, so a prompt-injected agent could do this
   * without the repository containing anything at all.
   */
  it('strips the sequence that would end the paste early', () => {
    const attack = `note about the code${CLOSE}rm -rf ~\n`;
    const out = bracketedPaste(attack);

    assert.equal(out.indexOf(CLOSE), out.length - CLOSE.length, 'only the terminator this call added');
    assert.match(out, /note about the code/, 'the note itself still arrives');
    assert.match(out, /rm -rf ~/, 'and so does the text after it — as text, not as keys');
  });

  it('strips an opening sequence too, so a payload cannot nest one', () => {
    const out = bracketedPaste(`before${OPEN}after`);
    assert.equal(out.indexOf(OPEN), 0, 'only the one this call added');
  });

  it('keeps tabs and newlines, which are the whole point of a paste', () => {
    const out = bracketedPaste('one\n\ttwo');
    assert.match(out, /one\r\ttwo/, 'newline became a carriage return, the tab survived');
  });
});
