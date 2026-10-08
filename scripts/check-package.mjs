import assert from 'node:assert/strict';
import { readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.equal(pkg.name, 'pi-acm-passive');
assert.equal(pkg.version, '1.4.0');
assert.deepEqual(pkg.pi.extensions, ['./extensions/index.ts', './extensions/no-summary-guard.ts']);
assert.deepEqual(pkg.pi.skills, []);
assert(pkg.keywords.includes('pi-package'));
assert.equal(pkg.dependencies['gpt-tokenizer'], '3.4.0');
for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']) {
  assert(pkg.peerDependencies[name]); assert(!pkg.dependencies[name], 'Do not bundle host libraries');
}
for (const path of [...pkg.pi.extensions, 'policy.json', 'README.md', 'LICENSE', 'NOTICE.md']) assert(existsSync(new URL('../' + path.replace(/^\.\//, ''), import.meta.url)), 'Missing ' + path);
const policy = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url)));
assert.equal(policy.noSummary, true);
assert.equal(policy.triggerRatio, 0.8); assert.equal(policy.targetRatio, 0.7);
for (const dir of ['extensions', 'src', 'tests']) {
  for (const item of readdirSync(new URL('../' + dir + '/', import.meta.url), { withFileTypes: true })) {
    const path = new URL('../' + dir + '/' + item.name, import.meta.url);
    assert(!lstatSync(path).isSymbolicLink(), 'Do not publish junctions/symlinks');
    if (!item.isFile()) continue;
    const text = readFileSync(path, 'utf8');
    assert(!text.includes('x1064') && !text.includes('/home/peicd/'), 'Personal path in ' + item.name);
  }
}
console.log('PASS: package manifest, ordered guard, policy, portable source files');
