import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20_000 });
  // Lets a single test — or a hand-picked subset, since this is a regex — run without the
  // rest of the suite around it. The tests share one VS Code window, so a hang or a failure
  // that only shows up in the full run is usually pollution left by an earlier test rather
  // than a defect in the failing one; this is how you bisect for which one.
  // e.g. MOCHA_GREP="reviews changes and walks" npm run test:integration
  if (process.env.MOCHA_GREP) mocha.grep(process.env.MOCHA_GREP);
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
