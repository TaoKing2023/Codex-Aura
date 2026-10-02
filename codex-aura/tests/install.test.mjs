// Installer integration tests use isolated Aura/Codex fixtures and a CLI double.
// Actual bridge apply/restore programs execute against these fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { install, restore } from '../scripts/install.mjs';

const actualBridgeRoot = fileURLToPath(new URL('../../codex-model/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };
async function write(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
const json = (file, value) => write(file, JSON.stringify(value, null, 2));

test('installer rejects an unset DSH router before attempting CLI registration or writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aura-missing-router-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await json(configPath, { routerRoot: '', codexHome: path.join(root, 'Codex home') });
  const before = await fs.readFile(configPath, 'utf8');
  await assert.rejects(install({ configPath, backupRoot: path.join(root, 'backup'),
    cli: { command: path.join(root, 'must-not-run'), prefixArgs: [] } }), /Configure routerRoot or CODEX_AURA_ROUTER_ROOT/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
  assert.equal(await exists(path.join(root, 'Codex home')), false);
  assert.equal(await exists(path.join(root, 'backup')), false);
});
async function snapshot(root) {
  const rows = {};
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name), relative = path.relative(root, file);
      if (item.isDirectory()) { rows[relative] = 'directory'; await walk(file); }
      else rows[relative] = hash(await fs.readFile(file));
    }
  }
  await walk(root); return rows;
}

const router = `import http from 'node:http';
import { join } from 'node:path';
const DSH_MODEL = 'DeepSeek Harness', DSH_PROFILE = 'acp';
const TEST_PROJECT = 'E:/Unreal_Projects/Test';
const CLOUD_COMMIT_WAIT_MS = 15000;
const FALLBACK_CWD = 'D:/fixture';
const UPSTREAM_BASE = 'https://example.invalid';
const CLOUD_THREADS = new Map();
const samePath = (a,b) => a === b;
function detectProject() { return { dir: TEST_PROJECT, name: 'Test' }; }
function modePolicy() { return { mcp: 'ro', pool: 'ro' }; }
function auraMcpServers() { return []; }
async function commitTurnToCloud() { return {}; }
async function auraCloudToken() { return 'fixture'; }
function loadSessionMap() { return {}; }
function isAuthorizedFor() { return false; }
const health = {
      model: DSH_MODEL, acpProfile: DSH_PROFILE,
};
export async function dispatch(parsed, req, res, cors, rec) {
  const wantsDsh = !!parsed && (
    parsed.model === DSH_MODEL
  );
  return wantsDsh ? 'dsh' : 'cloud';
}
`;
const fakeCli = `import { promises as fs } from 'node:fs';
import path from 'node:path';
const root = process.argv[2], args = process.argv.slice(3);
const fixture = JSON.parse(await fs.readFile(path.join(root,'cli-fixture.json'),'utf8'));
await fs.appendFile(path.join(root,'cli-calls.jsonl'), JSON.stringify(args)+'\\n');
const backupNames = (await fs.readdir(fixture.backupRoot)).filter(name=>name.startsWith('Codex-Aura-Install-'));
const backupDir = path.join(fixture.backupRoot,backupNames.at(-1));
const checkpoint = JSON.parse(await fs.readFile(path.join(backupDir,'manifest.json'),'utf8'));
if(checkpoint.complete || !checkpoint.files.some(row=>row.path===fixture.userConfig && row.existed)) throw Error('Original config was not checkpointed before CLI mutation');
await fs.appendFile(fixture.userConfig, '\\n# simulated supported CLI registration\\n');
await fs.mkdir(path.dirname(fixture.registry),{recursive:true});
await fs.writeFile(fixture.registry,JSON.stringify({ marketplace:'aura-local',registered:true }));
if(args[1]==='add') {
 const cache = path.join(fixture.codexHome,'plugins','cache','aura-local','codex-aura',fixture.cacheVersion || '0.1.0');
 await fs.mkdir(cache,{recursive:true});
 await fs.writeFile(path.join(cache,'cli-created.txt'),'registered plugin cache');
 if(fixture.scenario==='plugin-fail') { console.error('Simulated plugin registration failure'); process.exit(9); }
}
console.log(JSON.stringify({ok:true,command:args[1]}));
`;

async function fixture(t, { scenario = 'ok', cacheVersion = '0.1.0' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aura-install-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('codex-aura-install-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const pluginSource = path.join(root, 'plugin source'), bridgeSource = path.join(root, 'bridge source');
  const auraRoot = path.join(root, 'Aura app'), routerRoot = path.join(root, 'DSH router');
  const codexHome = path.join(root, 'Codex home'), dataRoot = path.join(root, 'plugin data'), backupRoot = path.join(root, 'backup');
  const configPath = path.join(root, 'config.json'), userConfig = path.join(codexHome, 'config.toml');
  const registry = path.join(codexHome, 'plugins', 'marketplaces.json');
  const catalogFile = path.join(auraRoot, 'next', '.next', 'static', 'chunks', '6927-fixture.js');
  const routerFile = path.join(routerRoot, 'AuraChatTap.mjs');
  const bridgeFile = path.join(auraRoot, 'next', 'aura-codex-bridge.mjs');
  const appServerFile = path.join(auraRoot, 'next', 'AuraCodexAppServer.mjs');
  await json(configPath, { auraRoot, routerRoot, codexHome, bridgeStore: path.join(root, 'threads.json'), testProject: path.join(root, 'Test') });
  await write(userConfig, 'model = "user-selected-model"\n');
  await json(registry, { previous: 'registered-marketplace' });
  await json(path.join(codexHome, 'auth.json'), { token: 'NEVER_BACKUP_AUTH_SENTINEL' });
  await write(path.join(codexHome, 'plugins', 'cache', 'other-market', 'other-plugin', '1.0', 'other.txt'), 'unrelated cache');
  await write(path.join(codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', '0.1.0', 'prior.txt'), 'previous private cache');
  await write(path.join(dataRoot, 'marketplace', 'plugins', 'other-plugin', 'unrelated.txt'), 'unrelated marketplace package');
  const mcp = { mcpServers: { codex_aura: { command: 'node', args: ['./mcp/server.mjs'], cwd: './' } } };
  await json(path.join(pluginSource, '.mcp.json'), mcp); await json(path.join(pluginSource, 'mcp.json'), mcp);
  await json(path.join(pluginSource, 'plugin.json'), { name: 'codex-aura', version: cacheVersion });
  await write(path.join(pluginSource, 'mcp', 'server.mjs'), '// fixture package only\n');
  await write(path.join(pluginSource, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Fixture\n---\n');
  await write(path.join(pluginSource, 'tests', 'excluded.txt'), 'not distributed');
  await json(path.join(pluginSource, 'auth.json'), { token: 'NEVER_STAGE_AUTH_SENTINEL' });
  await fs.mkdir(bridgeSource, { recursive: true });
  for (const name of ['apply-codex-model.cjs', 'restore-codex-model.cjs']) await fs.copyFile(path.join(actualBridgeRoot, name), path.join(bridgeSource, name));
  await write(path.join(bridgeSource, 'AuraCodexBridge.mjs'), 'export async function respondFromCodex() {}\n');
  await write(path.join(bridgeSource, 'AuraCodexAppServer.mjs'), 'export async function runAppServerTurn() {}\n');
  await write(catalogFile, 'const catalog={models:[{name:"DeepSeek Harness",displayName:"DeepSeek Harness",isToolCallUnsupported:!1,costMultiplier:void 0}]};\n');
  await write(routerFile, router);
  await json(path.join(root, 'cli-fixture.json'), { scenario, cacheVersion, codexHome, userConfig, registry, backupRoot });
  const cliFile = path.join(root, 'fake-cli.mjs'); await write(cliFile, fakeCli);
  const originals = new Map();
  for (const file of [configPath, userConfig, registry, catalogFile, routerFile]) originals.set(file, await fs.readFile(file));
  return { root, pluginSource, bridgeSource, auraRoot, routerRoot, codexHome, dataRoot, backupRoot, configPath, userConfig, registry,
    catalogFile, routerFile, bridgeFile, appServerFile, originals,
    options: { pluginSource, bridgeSource, configPath, dataRoot, backupRoot, cli: { command: process.execPath, prefixArgs: [cliFile, root] } } };
}
async function unchangedOriginals(h) { for (const [file, bytes] of h.originals) assert.deepEqual(await fs.readFile(file), bytes, file); }

test('dry run leaves all software, account configuration, caches and backups byte-for-byte untouched', async (t) => {
  const h = await fixture(t), before = await snapshot(h.root);
  const result = await install({ ...h.options, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.bridgePlan.changed.includes(h.appServerFile));
  assert.deepEqual(await snapshot(h.root), before);
  assert.equal(await exists(path.join(h.root, 'cli-calls.jsonl')), false);
  assert.equal(await exists(h.backupRoot), false);
});

test('compatibility upgrade checkpoints and removes only its obsolete portable entry, then restores it', async t => {
  const h = await fixture(t);
  await json(path.join(h.pluginSource, '.codex-plugin', 'plugin.json'), { name: 'codex-aura', version: '0.1.1', mcpServers: './.mcp.json' });
  const oldManifest = path.join(h.dataRoot, 'marketplace', 'plugins', 'codex-aura', 'plugin.json');
  await write(oldManifest, 'Previous portable manifest');
  const result = await install(h.options);
  assert.equal(await exists(oldManifest), false);
  assert.equal(await exists(path.join(result.pluginRoot, 'plugin.portable.json')), true);
  assert.equal(await exists(path.join(result.pluginRoot, '.codex-plugin', 'plugin.json')), true);
  const manifest = JSON.parse(await fs.readFile(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  const prior = manifest.files.find(row => row.path === oldManifest);
  assert.equal(prior.existed, true); assert.equal(prior.installedSha256, null);
  assert.equal(await fs.readFile(path.join(result.backupDir, prior.backupName), 'utf8'), 'Previous portable manifest');
  await restore(result.backupDir);
  assert.equal(await fs.readFile(oldManifest, 'utf8'), 'Previous portable manifest');
  assert.equal(await fs.readFile(path.join(h.dataRoot, 'marketplace', 'plugins', 'other-plugin', 'unrelated.txt'), 'utf8'), 'unrelated marketplace package');
});

test('installation checkpoints only managed files, then real bridge CLI restore works even after source moves', async (t) => {
  const h = await fixture(t);
  const result = await install(h.options);
  assert.equal(result.ok, true);
  const manifest = JSON.parse(await fs.readFile(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.bridgeRestoreScript, path.join(h.bridgeSource, 'restore-codex-model.cjs'));
  assert.ok(manifest.files.some(row => row.path === h.userConfig && row.existed));
  assert.ok(manifest.files.some(row => row.path === h.registry && row.existed));
  assert.ok(manifest.files.some(row => row.path.endsWith('cli-created.txt') && !row.existed));
  assert.ok(manifest.files.every(row => !row.path.includes('other-plugin') && !row.path.endsWith('auth.json')));
  for (const entry of await fs.readdir(result.backupDir)) {
    assert.doesNotMatch(await fs.readFile(path.join(result.backupDir, entry), 'utf8'), /NEVER_BACKUP_AUTH_SENTINEL|NEVER_STAGE_AUTH_SENTINEL/);
  }
  assert.equal(await exists(path.join(result.pluginRoot, 'auth.json')), false);
  assert.equal(await exists(path.join(result.pluginRoot, 'tests')), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.pluginRoot, '.mcp.json'), 'utf8')).mcpServers.codex_aura.command, process.execPath);
  await fs.rename(h.bridgeSource, h.bridgeSource + '-moved');
  const installed = await snapshot(h.root);
  const preview = await restore(result.backupDir, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(await snapshot(h.root), installed, 'Restore preflight must not write');
  const restored = await restore(result.backupDir);
  assert.equal(restored.restored, true);
  assert.ok(restored.bridge.restored.includes(h.bridgeFile));
  assert.ok(restored.bridge.restored.includes(h.appServerFile));
  await unchangedOriginals(h);
  assert.equal(await exists(h.bridgeFile), false);
  assert.equal(await exists(h.appServerFile), false);
  assert.equal(await exists(path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', '0.1.0', 'cli-created.txt')), false);
  assert.equal(await fs.readFile(path.join(h.codexHome, 'plugins', 'cache', 'other-market', 'other-plugin', '1.0', 'other.txt'), 'utf8'), 'unrelated cache');
  assert.ok(await exists(path.join(restored.recovery, 'manifest.json')));
});

test('CLI failure restores original user/plugin config and registry while removing only its newly created cache files', async (t) => {
  const h = await fixture(t, { scenario: 'plugin-fail' });
  await assert.rejects(install(h.options), /installation failed; managed files were restored.*Simulated plugin registration failure/s);
  await unchangedOriginals(h);
  assert.equal(await exists(h.bridgeFile), false);
  assert.equal(await exists(h.appServerFile), false);
  assert.equal(await exists(path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', '0.1.0', 'cli-created.txt')), false);
  assert.equal(await fs.readFile(path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', '0.1.0', 'prior.txt'), 'utf8'), 'previous private cache');
  assert.equal(await fs.readFile(path.join(h.dataRoot, 'marketplace', 'plugins', 'other-plugin', 'unrelated.txt'), 'utf8'), 'unrelated marketplace package');
  const checkpoint = (await fs.readdir(h.backupRoot)).find(name => name.startsWith('Codex-Aura-Install-'));
  assert.equal(JSON.parse(await fs.readFile(path.join(h.backupRoot, checkpoint, 'manifest.json'), 'utf8')).complete, false);
});

for (const cacheVersion of ['0.1.4', '0.1.5']) {
test(`installation checkpoints the ${cacheVersion} cache and restore removes only its newly created files`, async t => {
  const h = await fixture(t, { cacheVersion });
  const result = await install(h.options);
  const cacheRoot = path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', cacheVersion);
  const cacheFile = path.join(cacheRoot, 'cli-created.txt');
  const manifest = JSON.parse(await fs.readFile(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.cacheRoots.includes(cacheRoot));
  assert.ok(manifest.files.some(row => row.path === cacheFile && !row.existed && row.installedSha256));
  assert.equal(await fs.readFile(cacheFile, 'utf8'), 'registered plugin cache');
  await restore(result.backupDir);
  assert.equal(await exists(cacheFile), false);
  await unchangedOriginals(h);
  assert.equal(await fs.readFile(path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', '0.1.0', 'prior.txt'), 'utf8'), 'previous private cache');
});

test(`a failed ${cacheVersion} registration rolls back the new cache and preserves existing 0.1.0 data`, async t => {
  const h = await fixture(t, { cacheVersion, scenario: 'plugin-fail' });
  await assert.rejects(install(h.options), /installation failed; managed files were restored/);
  assert.equal(await exists(path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', cacheVersion, 'cli-created.txt')), false);
  await unchangedOriginals(h);
  assert.equal(await fs.readFile(path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', '0.1.0', 'prior.txt'), 'utf8'), 'previous private cache');
});
}

test('restore refuses subsequent changes before any recovery snapshot or other mutation', async (t) => {
  for (const change of ['config-edit', 'new-cache-file', 'bridge-edit']) {
    await t.test(change, async (t) => {
      const h = await fixture(t), result = await install(h.options);
      if (change === 'config-edit') await fs.appendFile(h.userConfig, '# subsequent user edit\n');
      else if (change === 'bridge-edit') await fs.appendFile(h.bridgeFile, '// subsequent upgrade\n');
      else await write(path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', '0.1.0', 'later.txt'), 'later addition');
      const before = await snapshot(h.root);
      await assert.rejects(restore(result.backupDir), /changed after installation|added after installation|File changed since installation/);
      assert.deepEqual(await snapshot(h.root), before);
    });
  }
});

test('restore rejects unexpected manifest targets and backup traversal before writing', async (t) => {
  for (const tamper of ['target', 'backup-member']) {
    await t.test(tamper, async (t) => {
      const h = await fixture(t), result = await install(h.options);
      const filename = path.join(result.backupDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (tamper === 'target') manifest.files.push({ path: path.join(h.root, 'unrelated.txt'), existed: false, installedSha256: null });
      else manifest.files.find(row => row.existed).backupName = '../escape';
      await json(filename, manifest);
      const before = await snapshot(h.root);
      await assert.rejects(restore(result.backupDir), /unexpected or duplicate managed target|Invalid backup member path/);
      assert.deepEqual(await snapshot(h.root), before);
    });
  }
});

test('cache-root junctions are refused without reading or backing up another tree', async (t) => {
  const h = await fixture(t);
  const versionRoot = path.join(h.codexHome, 'plugins', 'cache', 'aura-local', 'codex-aura', 'local');
  const outside = path.join(h.root, 'unrelated sensitive tree');
  await write(path.join(outside, 'do-not-copy.txt'), 'OUTSIDE_TREE_SENTINEL');
  await fs.symlink(outside, versionRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(install({ ...h.options, dryRun: true }), /Symlinks are not supported/);
  assert.equal(await exists(h.backupRoot), false);
  assert.equal(await exists(path.join(h.root, 'cli-calls.jsonl')), false);
  assert.equal(await fs.readFile(path.join(outside, 'do-not-copy.txt'), 'utf8'), 'OUTSIDE_TREE_SENTINEL');
});

test('plugin config cannot overwrite Codex auth or TOML settings', async (t) => {
  const h = await fixture(t);
  const auth = path.join(h.codexHome, 'auth.json');
  await json(auth, { codexHome: h.codexHome, auraRoot: h.auraRoot, routerRoot: h.routerRoot, token: 'KEEP_AUTH' });
  const before = await fs.readFile(auth);
  await assert.rejects(install({ ...h.options, configPath: auth, dryRun: true }), /separate from Codex authentication/);
  assert.deepEqual(await fs.readFile(auth), before);
  assert.equal(await exists(h.backupRoot), false);
});
