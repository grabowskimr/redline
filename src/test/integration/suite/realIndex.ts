import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

/** Loads only `*.real.js`, so the fixture suite does not run against a real repository. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 120_000 });
  const dir = __dirname;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.real.js')) mocha.addFile(path.join(dir, f));
  }
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} tests failed.`)) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}
