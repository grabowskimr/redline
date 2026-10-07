import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The published package is part of the product, and every one of these was wrong at least once.
 * A broken repository link or a stray build directory is not caught by any other test — it is
 * only visible to whoever installs it.
 */
describe('what gets published', () => {
  const root = path.resolve(__dirname, '../../..');
  interface Manifest {
    version?: string;
    repository?: { url?: string };
    bugs?: { url?: string };
    homepage?: string;
    categories?: string[];
    license?: string;
    icon?: string;
    displayName?: string;
    capabilities?: { untrustedWorkspaces?: { supported?: string; description?: string } };
    contributes?: { configuration?: { properties?: Record<string, unknown> }; configurationDefaults?: unknown };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
  /**
   * What `vsce` would actually put in the package.
   *
   * Asked of vsce rather than worked out from `.vscodeignore`, because reading the patterns is
   * how this was wrong: the file said what to leave out, so anything nobody had thought of went
   * in, and a test that checks the patterns are present agrees with it.
   */
  let packaged: string[] = [];
  before(function () {
    this.timeout(60_000);
    packaged = execFileSync('npx', ['vsce', 'ls'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
  });

  it('ships version 2 with a native view and no conversation commands', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(raw.version, '1.0.0');
    assert.equal(raw.contributes.views.redline[0].id, 'redline.changes');
    assert.equal(raw.contributes.views.redline[0].type, undefined);
    assert.equal(raw.contributes.keybindings, undefined);
    for (const command of raw.contributes.commands) assert.doesNotMatch(command.command, /Note|submit|send|ask|reply|Report|GitHub|AllChanges/);
  });

  it('points at a repository that exists', () => {
    // This pointed at github.com/marcin/redline, which is nobody's repository.
    assert.match(manifest.repository?.url ?? '', /^https:\/\/github\.com\/grabowskimr\/redline(\.git)?$/);
    assert.match(manifest.bugs?.url ?? '', /^https:\/\/github\.com\/grabowskimr\/redline\/issues$/);
    assert.ok(manifest.homepage, 'a homepage, so the marketplace links somewhere');
  });

  it('does not claim to be safe in an untrusted workspace', () => {
    // Git executes repository-controlled configuration and filters. This said `true`.
    const trust = manifest.capabilities?.untrustedWorkspaces;
    assert.equal(trust?.supported, 'limited');
    assert.ok(trust?.description, 'and says why, since VS Code shows it');
  });

  it('describes itself honestly', () => {
    assert.deepEqual(manifest.categories, ['AI', 'SCM Providers', 'Other'], 'it is not about notebooks');
    assert.ok(manifest.license && manifest.icon && manifest.displayName);
    assert.ok(fs.existsSync(path.join(root, 'LICENSE')), 'the licence ships');
    assert.ok(fs.existsSync(path.join(root, manifest.icon)), 'the icon it names exists');
  });

  it('ships these files and no others', () => {
    /*
     * The whole package, named. A scratch directory of compiled tests came within one command
     * of being published, and a stray `Support/Code/argv.json` — a mistyped path away from
     * home, holding a proposed-API flag for a feature that has since been deleted — actually
     * was, without anything failing.
     *
     * Adding a file to the extension means adding it here. That is the point: whatever reaches
     * other people's machines is a decision, not a leftover.
     */
    assert.deepEqual(packaged, [
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'dist/extension.js',
      'package.json',
      'resources/icon.png',
      'resources/icon.svg',
    ]);
  });

  it('excludes source, tests, dev scripts and any build directory', () => {
    for (const f of packaged) {
      assert.doesNotMatch(f, /^(src|out|scripts|spec|test-fixtures|node_modules|\.vscode)\//, `${f} is not shippable`);
      assert.doesNotMatch(f, /\.map$|\.vsix$|\.ts$/, `${f} is not shippable`);
    }
  });

  it('keeps the Claude Code marketplace at the repository root, where GitHub installs read it', () => {
    // `claude plugin marketplace add grabowskimr/redline` reads this file from the default
    // branch, and the setup command prints exactly that, so the extension ships no copy.
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'),
    ) as { name: string; plugins: Array<{ name: string; source: string }> };
    assert.equal(marketplace.name, 'redline');
    assert.deepEqual(marketplace.plugins.map((p) => [p.name, p.source]), [['redline', './plugin']]);
    assert.ok(fs.existsSync(path.join(root, 'plugin/hooks/hooks.json')));
    assert.ok(!packaged.some((f) => f.startsWith('plugin/') || f.startsWith('.claude-plugin/')));
  });

  it('keeps the plugin manifest free of the hooks file Claude Code loads by itself', () => {
    // Declaring it is a duplicate, and the whole plugin then fails to load — silently, except
    // in `claude plugin list`.
    const plugin = JSON.parse(
      fs.readFileSync(path.join(root, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(plugin.hooks, undefined);
    assert.equal(typeof plugin.author, 'object', 'author must be an object, not a string');
    assert.ok(fs.existsSync(path.join(root, 'plugin/hooks/hooks.json')), 'loaded by convention');
  });

  it('ships exactly one copy of the hook script', () => {
    // There were two, kept identical by a script in `npm test`. Nothing read the second one:
    // the plugin runs `plugin/hooks/`, and a manual install copies from there too. Two copies
    // of a file only one of which is ever executed is a drift waiting to happen.
    assert.ok(fs.existsSync(path.join(root, 'plugin/hooks/redline-touched.mjs')));
    assert.ok(!fs.existsSync(path.join(root, 'resources/redline-touched.mjs')), 'and only one');
  });

  it('paints none of the editor\'s own widget for you', () => {
    /*
     * It used to force `editorCommentsWidget.replyInputBackground` to fully transparent, so the
     * collapsed reply bar took the widget's colour instead of sitting on it as a slab. That bar
     * no longer exists — follow-ups happen on the card — and the only input left is the box you
     * write a note in, which was left looking like a hole in the widget rather than a field.
     *
     * A default here overrides every theme the user might install, so the bar for setting one
     * is high: it has to be right in all of them.
     */
    assert.equal(manifest.contributes?.configurationDefaults, undefined);
  });

  it('documents every setting it contributes, with the default it actually has', () => {
    /*
     * Checking only that the name appears let a row drift from the manifest: the README could
     * promise a default the product does not have, which is worse than saying nothing, because
     * someone reads it instead of trying it.
     */
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const props = manifest.contributes?.configuration?.properties ?? {};
    for (const [key, prop] of Object.entries(props)) {
      // The table row, not the first mention: several settings are also discussed in prose
      // above the table, and that prose has no default column to check.
      const row = readme
        .split('\n')
        .find((l) => l.trimStart().startsWith('|') && l.includes(`\`${key}\``));
      assert.ok(row, `${key} is not in the README`);
      // Split rather than matched: a table row's cells share their `|`, so a global regex that
      // consumes the closing pipe of one cell cannot then find the opening pipe of the next.
      const cells = row.split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
      const declared = (prop as { default?: unknown }).default;
      // Scalars only. An array default is shown in the README as the readable summary a person
      // wants — `node_modules`, `dist`, … — not as the globs it really holds, and forcing that
      // cell to be JSON would make the table worse to read in exchange for nothing.
      if (declared === null || typeof declared === 'object') continue;
      assert.equal(
        cells[2],
        String(declared),
        `${key}'s README row shows a default the manifest does not have`,
      );
    }
  });
});
