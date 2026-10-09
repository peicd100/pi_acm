import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { host, fromHost } from '../tests/runtime.mjs';

// Real Pi Git install: local fixture by default, actual public GitHub with
// --remote. No GitHub writes, provider requests or personal Pi modifications.
// npm may download the declared tokenizer dependency from its registry.
const remote = process.argv.includes('--remote');
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'pi acm 安裝 '));
const fixture = join(temp, 'source'), agent = join(temp, 'agent'), cwd = join(temp, 'work');
for (const path of [fixture, agent, cwd]) mkdirSync(path);
const repoURL = remote ? 'https://github.com/peicd100/pi_acm.git' : 'https://example.invalid/pi/acm.git';
const source = remote ? 'git:github.com/peicd100/pi_acm@v1.4.2' : 'git:' + repoURL + '@v1.4.2';
const installParts = remote ? ['github.com', 'peicd100', 'pi_acm'] : ['example.invalid', 'pi', 'acm'];
const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1',
  GIT_CONFIG_COUNT: remote ? '0' : '1', GIT_CONFIG_KEY_0: `url.${pathToFileURL(fixture).href.replace(/\/$/, '')}.insteadOf`, GIT_CONFIG_VALUE_0: repoURL,
  GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
writeFileSync(env.GIT_CONFIG_GLOBAL, '');
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ npmCommand: ['npm'] }));
const hostPackage = JSON.parse(readFileSync(join(host, 'package.json')));
const cli = join(host, typeof hostPackage.bin === 'string' ? hostPackage.bin : hostPackage.bin.pi);
function copyTree(source, target) {
  if (statSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const item of readdirSync(source)) copyTree(join(source, item), join(target, item));
  } else writeFileSync(target, readFileSync(source));
}
function run(command, args, directory = cwd) {
  const result = spawnSync(command, args, { cwd: directory, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const pi = args => run(process.execPath, [cli, ...args]);
let passed = false;
try {
  if (!remote) {
    for (const path of ['package.json', 'package-lock.json', 'extensions', 'src', 'policy.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE.md']) copyTree(join(root, path), join(fixture, path));
    run('git', ['init', '--quiet'], fixture);
    run('git', ['add', '.'], fixture);
    run('git', ['-c', 'user.name=ACM install fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Disposable install fixture'], fixture);
    run('git', ['tag', 'v1.4.2'], fixture);
  }
  pi(['install', source]);
  const settings = JSON.parse(readFileSync(join(agent, 'settings.json')));
  assert(settings.packages.some(p => (typeof p === 'string' ? p : p.source) === source));
  assert(pi(['list']).includes(installParts[0]));
  const installed = join(agent, 'git', ...installParts);
  const installedHead = run('git', ['rev-parse', 'HEAD'], installed).trim();
  assert.equal(run('git', ['describe', '--tags', '--exact-match'], installed).trim(), 'v1.4.2');
  assert(existsSync(join(installed, 'node_modules/gpt-tokenizer')), 'runtime dependency not installed');
  assert(!existsSync(join(installed, 'node_modules/@earendil-works/pi-coding-agent')), 'host must not be bundled');
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json')));
  const { loadExtensions } = await fromHost('dist/core/extensions/loader.js');
  // getAgentDir() is resolved lazily, so redirect it only for this load.
  const originalAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const loaded = await loadExtensions(pkg.pi.extensions.map(p => join(installed, p)), cwd);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 2);
    assert.deepEqual([...loaded.extensions[0].commands.keys()], ['acm-status', 'acm-config', 'acm-setup']);
    assert.equal(loaded.extensions[0].tools.size, 0);
    assert.equal(loaded.extensions[1].tools.size, 0);
  } finally {
    if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgent;
  }
  pi(['remove', source]);
  const removed = JSON.parse(readFileSync(join(agent, 'settings.json')));
  assert(!(removed.packages ?? []).some(p => (typeof p === 'string' ? p : p.source) === source));
  assert(!existsSync(installed));
  passed = true;
  console.log(`PASS: ${remote ? 'public GitHub' : 'local fixture'} Pi Git install/tag/list/load/remove; ${source}; HEAD=${installedHead}; production dependency only; space/non-ASCII path; no provider calls`);
} finally {
  if (passed) rmSync(temp, { recursive: true, force: true });
  else console.error('Failed installation fixture preserved at:', temp);
}
