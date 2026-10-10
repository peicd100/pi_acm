import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

// Use an explicit SDK or local devDependency; never probe personal directories.
export function resolveHost() {
  if (process.env.PI_TEST_HOST) {
    const path = resolve(process.env.PI_TEST_HOST);
    if (!existsSync(join(path, 'dist/index.js'))) throw new Error('PI_TEST_HOST must point to an installed Pi coding-agent package directory');
    return path;
  }
  try { return dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))); }
  catch { throw new Error('Pi test SDK not found. Run npm ci, or set PI_TEST_HOST to an installed @earendil-works/pi-coding-agent directory. No automatic downloads.'); }
}
export const host = resolveHost();
export const fromHost = relative => import(pathToFileURL(join(host, relative)).href);
const require = createRequire(join(host, 'package.json'));
const aiEntry = require.resolve.paths('@earendil-works/pi-ai')
  .map(root => join(root, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
if (!aiEntry) throw new Error('Pi SDK pi-ai dependency missing; run npm ci. No network fallback.');
export const ai = await import(pathToFileURL(aiEntry).href);
// Test-only differential access to the installed host's exported API subpaths.
export const fromAi = relative => import(pathToFileURL(join(dirname(aiEntry),relative)).href);
