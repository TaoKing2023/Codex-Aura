'use strict';

// All installer mutations below target a new temporary fixture. No Aura, DSH,
// Codex account, UE project, or real backup directory is opened for writing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { buildCatalog, buildRouter } = require('./apply-codex-model.cjs');

const dshEntry = '{name:"DeepSeek Harness",displayName:"DeepSeek Harness",isToolCallUnsupported:!1,costMultiplier:void 0}';
const catalog = 'const catalog={models:[{name:"auto",displayName:"Auto"},' + dshEntry + ']};\n';
const router = `import http from 'node:http';
import { join } from 'node:path';
const DSH_MODEL = 'DeepSeek Harness';
const DSH_PROFILE = 'acp';
const TEST_PROJECT = 'C:/FixtureProjects/Test';
const CLOUD_COMMIT_WAIT_MS = 15000;
const FALLBACK_CWD = 'D:/Aura fixture';
const UPSTREAM_BASE = 'https://example.invalid';
const CLOUD_THREADS = new Map();
const samePath = (a, b) => a === b;
function detectProject() { return { dir: TEST_PROJECT, name: 'Test' }; }
function modePolicy(body) { return { pool: body.mode === 'agentic' ? 'full' : 'ro', mcp: body.activeTool === false ? 'none' : 'ro' }; }
function auraMcpServers() { return []; }
async function commitTurnToCloud() { return {}; }
async function auraCloudToken() { return 'fixture-token'; }
function loadSessionMap() { return {}; }
function isAuthorizedFor(text, name) { return text === 'allow-edit ' + name; }
const health = {
      model: DSH_MODEL, acpProfile: DSH_PROFILE,
};
export async function dispatch(parsed, req, res, cors, rec) {
  const wantsDsh = !!parsed && (
    parsed.model === DSH_MODEL || parsed.modelId === DSH_MODEL ||
    (parsed.body && typeof parsed.body === 'object' && parsed.body.model === DSH_MODEL)
  );
  if (wantsDsh) return 'dsh';
  return 'cloud';
}
`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-codex-installer-test-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('aura-codex-installer-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const installerRoot = path.join(root, 'package');
  const appRoot = path.join(root, 'Aura app');
  const routerRoot = path.join(root, 'DSH router');
  const backupRoot = path.join(root, 'backup');
  const catalogFile = path.join(appRoot, 'next', '.next', 'static', 'chunks', '6927-fixture.js');
  const routerFile = path.join(routerRoot, 'AuraChatTap.mjs');
  const bridgeFile = path.join(appRoot, 'next', 'aura-codex-bridge.mjs');
  fs.mkdirSync(installerRoot, { recursive: true });
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
  fs.mkdirSync(routerRoot, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'apply-codex-model.cjs'), path.join(installerRoot, 'apply-codex-model.cjs'));
  fs.writeFileSync(path.join(installerRoot, 'AuraCodexAppServer.mjs'), 'export async function runAppServerTurn() {}\n');
  fs.writeFileSync(path.join(installerRoot, 'AuraCodexBridge.mjs'), changes.bridge ?? 'export async function respondFromCodex() {}\n');
  fs.writeFileSync(catalogFile, changes.catalog ?? catalog);
  fs.writeFileSync(routerFile, changes.router ?? router);
  const { install } = require(path.join(installerRoot, 'apply-codex-model.cjs'));
  const originals = new Map([[catalogFile, fs.readFileSync(catalogFile)], [routerFile, fs.readFileSync(routerFile)]]);
  return { root, appRoot, routerRoot, backupRoot, catalogFile, routerFile, bridgeFile, install, originals };
}
function unchanged(f) {
  for (const [file, bytes] of f.originals) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(f.bridgeFile), false);
  assert.equal(fs.existsSync(f.backupRoot), false);
}
function dispatchHook() {
  const generated = buildRouter(router, path.join(os.tmpdir(), 'Aura fixture', 'bridge.mjs'));
  const from = generated.indexOf('  // AURA_CODEX_DISPATCH_V1');
  const to = generated.indexOf('  const wantsDsh = !!parsed && (');
  assert.ok(from >= 0 && to > from);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('parsed', 'req', 'res', 'cors', 'rec', 'deps',
    `const { respondFromCodex, detectProject, modePolicy, auraMcpServers,
      commitTurnToCloud, CLOUD_COMMIT_WAIT_MS, FALLBACK_CWD, auraCloudToken,
      UPSTREAM_BASE, samePath, TEST_PROJECT, isAuthorizedFor, fetch, join,
      CLOUD_THREADS, loadSessionMap } = deps;\n`
    + generated.slice(from, to) + '\nreturn "existing-branches";');
}
function hookDependencies(onCall, overrides = {}) {
  return {
    respondFromCodex: onCall,
    detectProject: () => ({ dir: 'test', name: 'Test' }),
    modePolicy: body => ({ pool: body.mode === 'agentic' ? 'full' : 'ro', mcp: body.activeTool === false ? 'none' : 'full' }),
    auraMcpServers: () => [],
    commitTurnToCloud: async () => ({}),
    join: path.join,
    CLOUD_THREADS: new Map(),
    loadSessionMap: () => ({}),
    CLOUD_COMMIT_WAIT_MS: 15000,
    FALLBACK_CWD: 'fixture',
    auraCloudToken: async () => 'test-token',
    UPSTREAM_BASE: 'https://example.invalid',
    samePath: (a, b) => a === b,
    TEST_PROJECT: 'test',
    isAuthorizedFor: (text, name) => text === 'allow-edit ' + name,
    fetch: async () => { throw new Error('Unexpected network request'); },
    ...overrides,
  };
}

test('catalog adds Codex once while retaining Auto and DSH entries', () => {
  const patched = buildCatalog(catalog);
  assert.ok(patched.includes(dshEntry));
  assert.ok(patched.includes('{name:"auto",displayName:"Auto"}'));
  assert.equal(patched.match(/name:"Codex",/g).length, 1);
  assert.equal(buildCatalog(patched), patched);
});

test('catalog refuses missing or duplicated known insertion anchors', () => {
  assert.throws(() => buildCatalog('const catalog={models:[]};'), /expected one known anchor/);
  assert.throws(() => buildCatalog(catalog + catalog), /expected one known anchor/);
});

test('router adds a valid file URL import, one dispatch hook, and health marker', () => {
  const bridge = path.join(os.tmpdir(), 'Aura app', 'bridge.mjs');
  const patched = buildRouter(router, bridge);
  assert.ok(patched.includes(JSON.stringify(pathToFileURL(bridge).href)));
  assert.equal(patched.match(/AURA_CODEX_DISPATCH_V1/g).length, 1);
  assert.ok(patched.includes('model: DSH_MODEL, codexBridge: true, acpProfile: DSH_PROFILE,'));
  assert.equal(buildRouter(patched, bridge), patched);
  const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patched, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('router refuses a different installation path and missing runtime dependencies', () => {
  const patched = buildRouter(router, path.join(os.tmpdir(), 'bridge-a.mjs'));
  assert.throws(() => buildRouter(patched, path.join(os.tmpdir(), 'bridge-b.mjs')), /another installation/);
  assert.throws(() => buildRouter(router.replace('function detectProject(', 'function removedProject('), 'bridge.mjs'), /missing dependency function detectProject/);
  assert.throws(() => buildRouter(router.replace("import { join } from 'node:path';", ''), 'bridge.mjs'), /missing dependency import/);
});

test('Codex model and modelId carriers dispatch, including wrapped API bodies', async () => {
  const hook = dispatchHook();
  const bodies = [
    { model: 'Codex', messages: [{ role: 'user', content: 'hello' }] },
    { modelId: 'Codex' },
    { body: { model: 'Codex', messages: [] } },
    { body: { modelId: 'Codex' } },
  ];
  for (const body of bodies) {
    let call;
    await hook(body, { headers: { 'x-aura-probe': '1' } }, {}, {}, () => {}, hookDependencies(async (...args) => { call = args; }));
    assert.ok(call);
    assert.deepEqual(call[2], body.body ?? body);
    assert.equal(call[4].noArchive, true);
    assert.equal(typeof call[4].auraMcpServers, 'function');
    assert.equal(typeof call[4].readCloudHistory, 'function');
    assert.equal(typeof call[4].resolvePolicy, 'function');
  }
});

test('cloud, Auto, DSH, malformed JSON, and unrelated nested payloads retain existing routing', async () => {
  const hook = dispatchHook();
  for (const body of [null, {}, { model: 'auto' }, { model: 'DeepSeek Harness' }, { model: 'Opus 5.5' }, { body: { model: 'DeepSeek Harness' } }, { body: 'Codex' }]) {
    const result = await hook(body, { headers: {} }, {}, {}, () => {}, hookDependencies(async () => assert.fail('Codex was called')));
    assert.equal(result, 'existing-branches');
  }
});

test('router policy retains mode limits and project authorization guard', async () => {
  let options;
  await dispatchHook()({ model: 'Codex' }, { headers: {} }, {}, {}, () => {}, hookDependencies(async (...args) => { options = args[4]; }));
  assert.deepEqual(options.resolvePolicy({ mode: 'agentic' }, { dir: 'test', name: 'Test' }, 'edit'), { pool: 'full', mcp: 'full' });
  assert.deepEqual(options.resolvePolicy({ mode: 'agentic' }, { dir: 'other', name: 'Other' }, 'edit'), { pool: 'ro', mcp: 'ro', guarded: true });
  assert.deepEqual(options.resolvePolicy({ mode: 'agentic', activeTool: false }, { dir: 'other', name: 'Other' }, 'edit'), { pool: 'ro', mcp: 'none', guarded: true });
  assert.deepEqual(options.resolvePolicy({ mode: 'agentic' }, { dir: 'other', name: 'Other' }, 'allow-edit Other'), { pool: 'full', mcp: 'full' });
});

test('cloud history uses escaped conversation ID, token, response messages, and fails explicitly', async () => {
  let options;
  let request;
  const deps = hookDependencies(async (...args) => { options = args[4]; }, {
    fetch: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => ({ messages: [{ role: 'user', content: 'earlier' }] }) };
    },
  });
  await dispatchHook()({ model: 'Codex' }, { headers: {} }, {}, {}, () => {}, deps);
  assert.deepEqual(await options.readCloudHistory({ body: {} }), []);
  assert.equal(request, undefined);
  assert.deepEqual(await options.readCloudHistory({ body: { cloudThreadId: 'thread/a b' } }), [{ role: 'user', content: 'earlier' }]);
  assert.equal(request.url, 'https://example.invalid/api/threads/thread%2Fa%20b/messages?limit=200');
  assert.equal(request.init.headers.authorization, 'Bearer test-token');
  deps.fetch = async () => ({ ok: false, status: 503 });
  await dispatchHook()({ model: 'Codex' }, { headers: {} }, {}, {}, () => {}, deps);
  await assert.rejects(options.readCloudHistory({ body: { cloudThreadId: 'thread' } }), /Aura history HTTP 503/);
});

test('first Codex turn seeds an existing cloud thread and persists future cloud commits outside UE', async () => {
  let options;
  let committed;
  let loadedDir;
  let fetched = 0;
  const deps = hookDependencies(async (...args) => { options = args[4]; }, {
    loadSessionMap: dir => { loadedDir = dir; return {}; },
    fetch: async (url, init) => {
      fetched++;
      assert.equal(url, 'https://example.invalid/api/threads/existing%2Fthread/messages?limit=200');
      assert.equal(init.headers.authorization, 'Bearer test-token');
      return { ok: true, json: async () => ({ messages: [{ seq: 2 }, { seq: 7 }, { seq: 4 }] }) };
    },
    commitTurnToCloud: async params => { committed = params; return { threadId: 'existing/thread', headSeq: 9 }; },
  });
  await dispatchHook()({ model: 'Codex' }, { headers: {} }, {}, {}, () => {}, deps);
  const params = { convId: 'creation-key', cloudThreadId: 'existing/thread', title: 'Original conversation', answer: 'reply' };
  assert.deepEqual(await options.commitTurnToCloud(params), { threadId: 'existing/thread', headSeq: 9 });
  assert.equal(fetched, 1);
  assert.deepEqual(deps.CLOUD_THREADS.get('creation-key'), { threadId: 'existing/thread', headSeq: 7, title: 'Original conversation' });
  assert.equal(loadedDir, options.cloudProjectDir);
  assert.equal(committed.projectDir, options.cloudProjectDir);
  assert.ok(options.cloudProjectDir.endsWith(path.join('Aura', 'CodexBridge', 'CloudHistory')));
  await options.commitTurnToCloud(params);
  assert.equal(fetched, 1, 'cached cloud head should be reused');
});

test('durable cloud mapping bypasses reseeding and an unavailable cloud head refuses append', async () => {
  let options;
  let appended = false;
  const cached = hookDependencies(async (...args) => { options = args[4]; }, {
    loadSessionMap: () => ({ '_cloud:known': { threadId: 'existing' } }),
    commitTurnToCloud: async () => { appended = true; },
  });
  await dispatchHook()({ model: 'Codex' }, { headers: {} }, {}, {}, () => {}, cached);
  await options.commitTurnToCloud({ convId: 'known', cloudThreadId: 'existing' });
  assert.equal(appended, true);
  appended = false;
  const failed = hookDependencies(async (...args) => { options = args[4]; }, {
    fetch: async () => ({ ok: false, status: 503 }),
    commitTurnToCloud: async () => { appended = true; },
  });
  await dispatchHook()({ model: 'Codex' }, { headers: {} }, {}, {}, () => {}, failed);
  await assert.rejects(options.commitTurnToCloud({ convId: 'new', cloudThreadId: 'existing' }), /Aura thread head HTTP 503/);
  assert.equal(appended, false);
});

test('dry run validates all sources and leaves destinations and backups untouched', t => {
  const f = fixture(t);
  const result = f.install({ ...f, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.changed.length, 4);
  unchanged(f);
});

test('install backs up original bytes and records every installed hash; rerun is idempotent', t => {
  const f = fixture(t);
  const beforeMode = fs.statSync(f.catalogFile).mode;
  const result = f.install(f);
  assert.equal(result.changed.length, 4);
  assert.equal(path.dirname(result.backupDir), f.backupRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 4);
  for (const entry of manifest.files) {
    assert.equal(entry.installedSha256, hash(fs.readFileSync(entry.path)));
    if (entry.existed) {
      const backup = fs.readFileSync(path.join(result.backupDir, entry.backupName));
      assert.deepEqual(backup, f.originals.get(entry.path));
      assert.equal(entry.sha256, hash(backup));
    } else {
      assert.ok([f.bridgeFile, path.join(f.appRoot, 'next', 'AuraCodexAppServer.mjs')].includes(entry.path));
      assert.equal(entry.sha256, null);
      assert.equal(fs.existsSync(path.join(result.backupDir, entry.backupName)), false);
    }
  }
  assert.equal(fs.statSync(f.catalogFile).mode, beforeMode);
  assert.deepEqual(f.install(f), { alreadyInstalled: true, changed: [] });
  assert.equal(fs.readdirSync(f.backupRoot).length, 1);
});

test('unknown catalog, missing router dependency, and invalid bridge fail before any destination write', t => {
  for (const changes of [
    { catalog: 'const models=[];' },
    { router: router.replace('async function auraCloudToken(', 'async function removedToken(') },
    { bridge: 'export async function broken(' },
  ]) {
    const f = fixture(t, changes);
    assert.throws(() => f.install(f));
    unchanged(f);
  }
});

test('ambiguous Aura model chunk selection fails before any destination write', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(path.dirname(f.catalogFile), '6927-other.js'), catalog);
  assert.throws(() => f.install(f), /Expected Aura 1.0.6 model catalog/);
  unchanged(f);
});

test('failed final write rolls back the router, catalog, and new bridge after complete backups', t => {
  const f = fixture(t);
  const originalWrite = fs.writeFileSync;
  let failed = false;
  let sawCompleteBackupBeforeWrite = false;
  fs.writeFileSync = function (file, ...args) {
    if (path.resolve(file) === path.resolve(f.bridgeFile)) {
      const dirs = fs.readdirSync(f.backupRoot);
      const manifestPath = path.join(f.backupRoot, dirs[0], 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      sawCompleteBackupBeforeWrite = manifest.files.length === 4 && manifest.files.every(e =>
        !e.existed || hash(fs.readFileSync(path.join(path.dirname(manifestPath), e.backupName))) === e.sha256);
    }
    if (!failed && path.resolve(file) === path.resolve(f.catalogFile)) {
      failed = true;
      originalWrite.call(fs, file, 'partial failed write');
      throw new Error('simulated catalog write failure');
    }
    return originalWrite.call(fs, file, ...args);
  };
  try {
    assert.throws(() => f.install(f), /simulated catalog write failure/);
  } finally { fs.writeFileSync = originalWrite; }
  assert.equal(sawCompleteBackupBeforeWrite, true);
  for (const [file, bytes] of f.originals) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(f.bridgeFile), false);
  assert.equal(fs.readdirSync(f.backupRoot).length, 1);
});

test('restore dry run is read-only; real restore recovers originals with a prior installed snapshot', t => {
  const f = fixture(t);
  const result = f.install(f);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  const installed = new Map(manifest.files.map(e => [e.path, fs.readFileSync(e.path)]));
  const restoreScript = path.join(__dirname, 'restore-codex-model.cjs');
  const preview = spawnSync(process.execPath, [restoreScript, result.backupDir, '--dry-run'], { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(fs.readdirSync(f.backupRoot).length, 1);
  for (const [file, bytes] of installed) assert.deepEqual(fs.readFileSync(file), bytes);
  const restored = spawnSync(process.execPath, [restoreScript, result.backupDir], { encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  const output = JSON.parse(restored.stdout);
  assert.equal(path.dirname(output.beforeRestoreBackup), f.backupRoot);
  for (const [file, bytes] of f.originals) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(f.bridgeFile), false);
  for (const [i, entry] of manifest.files.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(output.beforeRestoreBackup, `${i}-${path.basename(entry.path)}`)), installed.get(entry.path));
  }
});

test('restore refuses later destination changes before writing or creating a snapshot', t => {
  const f = fixture(t);
  const result = f.install(f);
  fs.appendFileSync(f.catalogFile, '\n// later Aura upgrade\n');
  const current = new Map(result.changed.map(file => [file, fs.readFileSync(file)]));
  const restored = spawnSync(process.execPath, [path.join(__dirname, 'restore-codex-model.cjs'), result.backupDir], { encoding: 'utf8' });
  assert.notEqual(restored.status, 0);
  assert.match(restored.stderr, /File changed since installation/);
  for (const [file, bytes] of current) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readdirSync(f.backupRoot).length, 1);
});

test('restore rejects corrupted backup bytes and unexpected manifest targets before writing', t => {
  for (const tamper of ['backup', 'target']) {
    const f = fixture(t);
    const result = f.install(f);
    const manifestFile = path.join(result.backupDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (tamper === 'backup') {
      const prior = manifest.files.find(e => e.existed);
      fs.appendFileSync(path.join(result.backupDir, prior.backupName), 'corrupt');
    } else {
      manifest.files[0].path = path.join(f.root, 'unexpected-file.mjs');
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    const current = new Map(result.changed.map(file => [file, fs.readFileSync(file)]));
    const restored = spawnSync(process.execPath, [path.join(__dirname, 'restore-codex-model.cjs'), result.backupDir], { encoding: 'utf8' });
    assert.notEqual(restored.status, 0);
    assert.match(restored.stderr, tamper === 'backup' ? /Backup hash mismatch/ : /Backup names an unexpected target/);
    for (const [file, bytes] of current) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.readdirSync(f.backupRoot).length, 1);
  }
});
