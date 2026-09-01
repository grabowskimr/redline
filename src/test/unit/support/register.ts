/**
 * Make `require('vscode')` resolve to the stub, for the unit suite only.
 *
 * The editor injects that module at runtime; outside it there is nothing to resolve, which is
 * why every file importing it was beyond the reach of these tests. Registered from `.mocharc`
 * so it is in place before the first test file is loaded — a module that has already resolved
 * `vscode` cannot be given a different one afterwards.
 */
import * as path from 'node:path';
import Module = require('node:module');

const stub = path.join(__dirname, 'vscode.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (Module as any)._load as (request: string, parent: unknown, isMain: boolean) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') return load(stub, parent, isMain);
  return load(request, parent, isMain);
};
