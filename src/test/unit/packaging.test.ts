import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The published package is part of the product, and every one of these was wrong at least once.
 * A broken repository link or a stray build directory is not caught by any other test — it is
 * only visible to whoever installs it.
 */
describe('what gets published', () => {
  const root = path.resolve(__dirname, '../../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, any>;
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());

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

  it('excludes source, tests, dev scripts and any build directory', () => {
    // A scratch directory of compiled tests came within one command of being published.
    for (const pattern of ['src/**', 'out*/**', 'scripts/**', 'test-fixtures/**', 'node_modules/**', '**/*.map']) {
      assert.ok(ignore.includes(pattern), `.vscodeignore is missing ${pattern}`);
    }
  });

  it('ships the Claude Code plugin, because the setup command installs from here', () => {
    assert.ok(fs.existsSync(path.join(root, 'plugin/.claude-plugin/plugin.json')));
    assert.ok(fs.existsSync(path.join(root, 'plugin/hooks/hooks.json')));
    assert.ok(fs.existsSync(path.join(root, '.claude-plugin/marketplace.json')));
    for (const pattern of ignore) {
      assert.ok(!/^plugin/.test(pattern), `.vscodeignore would drop the plugin: ${pattern}`);
    }
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

  it('keeps the two copies of the hook script identical', () => {
    // One is what the plugin runs, the other is what a manual install copies. Shipping two
    // different versions of the same hook would be invisible until it misbehaved.
    const a = fs.readFileSync(path.join(root, 'resources/redline-touched.mjs'), 'utf8');
    const b = fs.readFileSync(path.join(root, 'plugin/hooks/redline-touched.mjs'), 'utf8');
    assert.equal(a, b);
  });

  it('documents every setting it contributes', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    for (const key of Object.keys(manifest.contributes?.configuration?.properties ?? {})) {
      assert.ok(readme.includes(`\`${key}\``), `${key} is not in the README`);
    }
  });
});
