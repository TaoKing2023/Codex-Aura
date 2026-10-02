// Aura 1.0.6 + existing DSH router: add Codex without changing cloud transports.
// Every affected file is backed up and hashed before the first installation write.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function replaceOnce(text, before, after, label) {
  if (text.includes(after)) return text;
  if (text.split(before).length !== 2) throw new Error(`${label}: expected one known anchor; nothing installed`);
  return text.replace(before, after);
}
function buildCatalog(text) {
  const dsh = '{name:"DeepSeek Harness",displayName:"DeepSeek Harness",isToolCallUnsupported:!1,costMultiplier:void 0}';
  const codex = '{name:"Codex",displayName:"Codex",isToolCallUnsupported:!1,costMultiplier:void 0}';
  if (text.includes(codex)) return text;
  return replaceOnce(text, dsh + ']}', dsh + ',' + codex + ']}', 'DSH model catalog');
}
function buildRouter(text, bridgePath) {
  const required = [
    "import { join } from 'node:path';",
    'function detectProject(', 'function modePolicy(', 'function auraMcpServers(',
    'async function commitTurnToCloud(', 'async function auraCloudToken(',
    'function loadSessionMap(', 'const CLOUD_THREADS =',
    'const samePath =', 'function isAuthorizedFor(', 'const TEST_PROJECT =',
    'const CLOUD_COMMIT_WAIT_MS =', 'const FALLBACK_CWD =', 'const UPSTREAM_BASE =',
  ];
  for (const marker of required) {
    if (!text.includes(marker)) throw new Error('Unsupported DSH router: missing dependency ' + marker);
  }
  const importLine = `import { respondFromCodex } from ${JSON.stringify(pathToFileURL(bridgePath).href)}; // AURA_CODEX_BRIDGE_V1`;
  if (text.includes('AURA_CODEX_BRIDGE_V1') && !text.includes(importLine)) {
    throw new Error('Existing Codex bridge points at another installation; restore it before changing AppRoot');
  }
  text = replaceOnce(text, "import http from 'node:http';", "import http from 'node:http';\n" + importLine, 'router import');
  const anchor = '  const wantsDsh = !!parsed && (';
  const hook = `  // AURA_CODEX_DISPATCH_V1: preserve every existing DSH/cloud branch.
  const codexCarrier = parsed && typeof parsed.body === 'object' && parsed.body !== null
    && (parsed.body.model === 'Codex' || parsed.body.modelId === 'Codex') ? parsed.body : parsed;
  if (codexCarrier && (codexCarrier.model === 'Codex' || codexCarrier.modelId === 'Codex')) {
    const probe = String(req.headers['x-aura-probe'] || '') === '1';
    await respondFromCodex(res, cors, codexCarrier, rec, {
      noArchive: probe, detectProject, modePolicy, auraMcpServers,
      cloudCommitWaitMs: CLOUD_COMMIT_WAIT_MS,
      cloudProjectDir: join(process.env.LOCALAPPDATA || FALLBACK_CWD, 'Aura', 'CodexBridge', 'CloudHistory'),
      commitTurnToCloud: async (params) => {
        // A first Codex turn may continue a thread answered by another model.
        // Seed Aura's existing cloud writer with that thread before appending.
        const cloudDir = join(process.env.LOCALAPPDATA || FALLBACK_CWD, 'Aura', 'CodexBridge', 'CloudHistory');
        if (params.cloudThreadId && !CLOUD_THREADS.get(params.convId)
            && !loadSessionMap(cloudDir)['_cloud:' + params.convId]) {
          const token = await auraCloudToken();
          const response = await fetch(UPSTREAM_BASE + '/api/threads/' + encodeURIComponent(params.cloudThreadId) + '/messages?limit=200', {
            headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) throw new Error('Aura thread head HTTP ' + response.status);
          const messages = (await response.json()).messages || [];
          const headSeq = messages.reduce((max, m) => Math.max(max, Number(m.seq) || 0), 0);
          CLOUD_THREADS.set(params.convId, { threadId: params.cloudThreadId, headSeq, title: params.title });
        }
        return commitTurnToCloud({ ...params, projectDir: cloudDir });
      },
      fallbackCwd: FALLBACK_CWD,
      readCloudHistory: async ({ body }) => {
        const id = body.cloudThreadId;
        if (!id) return [];
        const token = await auraCloudToken();
        const response = await fetch(UPSTREAM_BASE + '/api/threads/' + encodeURIComponent(id) + '/messages?limit=200', {
          headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Aura history HTTP ' + response.status);
        return (await response.json()).messages || [];
      },
      resolvePolicy: (body, project, userText) => {
        const mode = modePolicy(body);
        const onTest = samePath(project.dir, TEST_PROJECT) || (!project.dir && !TEST_PROJECT);
        const guarded = !onTest && !isAuthorizedFor(userText, project.name);
        return guarded ? { ...mode, pool: 'ro', mcp: mode.mcp === 'none' ? 'none' : 'ro', guarded: true } : mode;
      },
    });
    return;
  }
`;
  text = replaceOnce(text, anchor, hook + anchor, 'router dispatch');
  text = replaceOnce(text, '      model: DSH_MODEL, acpProfile: DSH_PROFILE,',
    '      model: DSH_MODEL, codexBridge: true, acpProfile: DSH_PROFILE,', 'router health');
  return text;
}

function checkSyntax(text, label) {
  // Node can validate module stdin without writing a staging file.
  const out = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: text, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`${label}: syntax check failed\n${out.stderr}`);
}
function writePreservingMode(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  const mode = existed ? fs.statSync(file).mode : null;
  try {
    if (existed) fs.chmodSync(file, 0o666);
    fs.writeFileSync(file, bytes);
  } finally { if (mode !== null) fs.chmodSync(file, mode); }
}
function install({ appRoot, routerRoot, backupRoot, dryRun = false }) {
  if (typeof routerRoot !== 'string' || !routerRoot.trim()) throw new Error('Supply --router-root or CODEX_AURA_ROUTER_ROOT with the existing DSH Aura router directory.');
  const chunkDir = path.join(appRoot, 'next', '.next', 'static', 'chunks');
  const catalogs = fs.readdirSync(chunkDir).filter(f => /^6927-.*\.js$/.test(f));
  if (catalogs.length !== 1) throw new Error('Expected Aura 1.0.6 model catalog; inspect this Aura version first');
  const catalogFile = path.join(chunkDir, catalogs[0]);
  const routerFile = path.join(routerRoot, 'AuraChatTap.mjs');
  const bridgeFile = path.join(appRoot, 'next', 'aura-codex-bridge.mjs');
  const bridgeSource = path.join(__dirname, 'AuraCodexBridge.mjs');
  const edits = [
    { file: path.join(appRoot, 'next', 'AuraCodexAppServer.mjs'), bytes: fs.readFileSync(path.join(__dirname, 'AuraCodexAppServer.mjs')) },
    { file: bridgeFile, bytes: fs.readFileSync(bridgeSource) },
    { file: routerFile, bytes: Buffer.from(buildRouter(fs.readFileSync(routerFile, 'utf8'), bridgeFile)) },
    { file: catalogFile, bytes: Buffer.from(buildCatalog(fs.readFileSync(catalogFile, 'utf8'))) },
  ];
  for (const edit of edits) checkSyntax(edit.bytes.toString('utf8'), edit.file);
  const changed = edits.filter(e => !fs.existsSync(e.file) || !fs.readFileSync(e.file).equals(e.bytes));
  if (!changed.length) return { alreadyInstalled: true, changed: [] };
  if (dryRun) return { dryRun: true, changed: changed.map(e => e.file) };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, 'Codex-Model-' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const manifest = { version: 1, appRoot, routerRoot, createdAt: new Date().toISOString(), files: [] };
  changed.forEach((e, i) => {
    const existed = fs.existsSync(e.file);
    const backupName = `${i}-${path.basename(e.file)}`;
    const prior = existed ? fs.readFileSync(e.file) : null;
    if (existed) fs.writeFileSync(path.join(backupDir, backupName), prior);
    manifest.files.push({ path: e.file, existed, backupName, sha256: prior && hash(prior), installedSha256: hash(e.bytes) });
  });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // Backups are complete before any destination is touched. On failure restore all originals.
  try {
    for (const e of changed) writePreservingMode(e.file, e.bytes);
    for (const e of changed) if (hash(fs.readFileSync(e.file)) !== hash(e.bytes)) throw new Error('Installed hash mismatch: ' + e.file);
  } catch (error) {
    for (const e of manifest.files) {
      if (e.existed) writePreservingMode(e.path, fs.readFileSync(path.join(backupDir, e.backupName)));
      else if (fs.existsSync(e.path)) fs.unlinkSync(e.path);
    }
    throw error;
  }
  return { backupDir, changed: changed.map(e => e.file), sha256: changed.map(e => ({ file: e.file, sha256: hash(e.bytes) })) };
}
module.exports = { buildCatalog, buildRouter, install };
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
  try {
    console.log(JSON.stringify(install({
      appRoot: value('--app-root', path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Programs', 'aura-client')),
      routerRoot: value('--router-root', process.env.CODEX_AURA_ROUTER_ROOT || ''),
      backupRoot: value('--backup-root', path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Aura', 'CodexAura', 'backups')), dryRun: args.includes('--dry-run'),
    }), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
