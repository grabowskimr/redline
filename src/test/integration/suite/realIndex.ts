import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

/**
 * Loads only `*.real.js`, so the fixture suite does not run against a real repository.
 *
 * The scenario builds a repository in a known state and asserts on it exactly, so the general
 * suite — which creates, deletes and renames files to prove those show up — is left out of
 * that run rather than moving the ground under it.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 120_000 });
  const dir = __dirname;
  const scenario = process.env.REDLINE_SCENARIO === '1';
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.real.js')) continue;
    if (scenario !== f.startsWith('scenario.')) continue;
    mocha.addFile(path.join(dir, f));
  }
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} tests failed.`)) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}
