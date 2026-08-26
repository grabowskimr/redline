import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20_000 });
  const dir = __dirname;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.test.js')) mocha.addFile(path.join(dir, f));
  }
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} tests failed.`)) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}
