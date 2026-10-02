// Install this local plugin using supported Codex commands. Back up all
// managed files before overwriting them; authentication files are never copied.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { loadConfig, resolveCli, defaultBackupRoot } from '../lib/config.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const MANAGED_CACHE = ['local', '0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5'];
const REGISTRY_FILES = ['marketplaces.json', 'known_marketplaces.json', 'installed_plugins.json'];
const credential = file => path.basename(file).toLowerCase() === 'auth.json';
const cachePaths = home => MANAGED_CACHE.map(version => path.join(home, 'plugins', 'cache', 'aura-local', 'codex-aura', version));
const registryPaths = home => REGISTRY_FILES.map(name => path.join(home, 'plugins', name));
async function noSymlinks(file) {
  for (let target = path.resolve(file);;) {
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Symlinks are not supported in the private plugin installation: ' + target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(target); if (parent === target) break; target = parent;
  }
}
async function files(root) {
  await noSymlinks(root);
  const result = [];
  async function walk(dir) {
    let rows; try { rows = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const row of rows) {
      const file = path.join(dir, row.name);
      if (row.isSymbolicLink()) throw new Error('Symlinks are not supported in the private plugin installation: ' + file);
      if (row.isDirectory()) await walk(file);
      else if (row.isFile()) result.push(file);
    }
  }
  await walk(root); return result;
}
async function read(file) { await noSymlinks(file); try { return await fs.readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function write(file, bytes) { await noSymlinks(file); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
const within = (file, root) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const same = (a, b) => path.resolve(a) === path.resolve(b);
function managedTargets(manifest) {
  if (!path.isAbsolute(manifest.marketRoot || '') || !path.isAbsolute(manifest.codexHome || '') || !path.isAbsolute(manifest.configPath || '')) throw new Error('Invalid managed checkpoint roots.');
  if (credential(manifest.configPath) || same(manifest.configPath, path.join(manifest.codexHome, 'config.toml'))) throw new Error('Plugin JSON configuration must be separate from Codex authentication and TOML configuration.');
  const acceptedCaches = cachePaths(manifest.codexHome);
  if (!Array.isArray(manifest.cacheRoots) || !manifest.cacheRoots.length
    || new Set(manifest.cacheRoots.map(root => path.resolve(root))).size !== manifest.cacheRoots.length
    || manifest.cacheRoots.some(root => !acceptedCaches.some(accepted => same(root, accepted)))) throw new Error('Unexpected cache roots.');
  const roots = [path.join(manifest.marketRoot, 'plugins', 'codex-aura'), ...manifest.cacheRoots];
  const exact = [path.join(manifest.marketRoot, '.agents', 'plugins', 'marketplace.json'), manifest.configPath, path.join(manifest.codexHome, 'config.toml'), ...registryPaths(manifest.codexHome)];
  return { roots, exact, allowed: file => path.isAbsolute(file) && !credential(file) && (exact.some(target => same(file, target)) || roots.some(root => within(file, root))) };
}
async function restoreBridge(manifest, backupDir, { dryRun = false, restoreScript } = {}) {
  if (!manifest.bridgeBackup) return null;
  let script = restoreScript && path.resolve(restoreScript);
  if (!script && manifest.bridgeRestoreBackupName) {
    if (path.basename(manifest.bridgeRestoreBackupName) !== manifest.bridgeRestoreBackupName) throw new Error('Invalid bridge restore backup member path.');
    script = path.join(backupDir, manifest.bridgeRestoreBackupName);
    if (sha(await fs.readFile(script)) !== manifest.bridgeRestoreSha256) throw new Error('Bridge restore backup hash mismatch.');
  }
  if (!script) {
    for (const candidate of [manifest.bridgeRestoreScript, path.resolve(sourceRoot, '..', 'codex-model', 'restore-codex-model.cjs')].filter(Boolean)) {
      try { await fs.access(candidate); script = candidate; break; } catch { /* original source can move */ }
    }
  }
  if (!script) throw new Error('Bridge restore script unavailable; supply restoreScript or --bridge-restore-script from the original package.');
  // The bridge exposes a CLI, not a module function; keep its actual interface.
  const { stdout } = await exec(process.execPath, [script, manifest.bridgeBackup, ...(dryRun ? ['--dry-run'] : [])], { windowsHide: true, timeout: 60_000, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

export async function install({ pluginSource = sourceRoot, bridgeSource = path.resolve(sourceRoot, '..', 'codex-model'), configPath,
  backupRoot = defaultBackupRoot(), dataRoot, dryRun = false, cli: suppliedCli } = {}) {
  const config = await loadConfig({ configPath });
  if (!config.routerRoot) throw new Error('Configure routerRoot or CODEX_AURA_ROUTER_ROOT with the existing DSH Aura router directory before installation.');
  const cli = suppliedCli || await resolveCli(config);
  const store = path.resolve(dataRoot || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Aura', 'CodexAura'));
  const marketRoot = path.join(store, 'marketplace');
  const pluginRoot = path.join(marketRoot, 'plugins', 'codex-aura');
  const catalog = path.join(marketRoot, '.agents', 'plugins', 'marketplace.json');
  const userConfig = path.join(config.codexHome, 'config.toml');
  const cacheRoots = cachePaths(config.codexHome);
  const context = { marketRoot, codexHome: config.codexHome, configPath: config.configPath, cacheRoots };
  const managed = managedTargets(context);
  const compatibilityRuntime = Boolean(await read(path.join(pluginSource, '.codex-plugin', 'plugin.json')));
  const obsoletePortableManifest = path.join(pluginRoot, 'plugin.json');
  for (const target of [...managed.roots, ...managed.exact, backupRoot]) await noSymlinks(target);
  if (managed.roots.some(root => same(backupRoot, root) || within(backupRoot, root) || same(pluginSource, root) || within(pluginSource, root))) throw new Error('Source and backups must be outside managed package directories.');
  const staging = [];
  for (const file of await files(pluginSource)) {
    const relative = path.relative(pluginSource, file);
    if (relative.split(path.sep).some(part => ['tests', 'evidence', 'node_modules'].includes(part)) || credential(file)) continue;
    staging.push({ file: path.join(pluginRoot, compatibilityRuntime && relative === 'plugin.json' ? 'plugin.portable.json' : relative), bytes: await fs.readFile(file) });
  }
  for (const name of ['mcp.json', '.mcp.json']) {
    const entry = staging.find(row => row.file === path.join(pluginRoot, name));
    if (!entry) throw new Error('Missing plugin MCP manifest: ' + name);
    const mcp = JSON.parse(entry.bytes);
    mcp.mcpServers.codex_aura.command = process.execPath;
    entry.bytes = Buffer.from(JSON.stringify(mcp, null, 2) + '\n');
  }
  staging.push({ file: catalog, bytes: Buffer.from(JSON.stringify({ name: 'aura-local', interface: { displayName: 'Aura Local Plugins' }, plugins: [{
    name: 'codex-aura', source: { source: 'local', path: './plugins/codex-aura' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools',
  }] }, null, 2) + '\n') });
  // Keep existing user-selected paths. Model and reasoning remain invariants.
  const previousConfig = await read(config.configPath);
  const storedConfig = previousConfig ? JSON.parse(previousConfig) : {};
  staging.push({ file: config.configPath, bytes: Buffer.from(JSON.stringify({ ...storedConfig,
    auraRoot: config.auraRoot, auraMcpConfig: config.auraMcpConfig, routerRoot: config.routerRoot,
    routerUrl: config.routerUrl, codexHome: config.codexHome, bridgeStore: config.bridgeStore,
    cliPath: /^([A-Za-z]:)?[\\/].*[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]/i.test(config.cliPath) ? '' : config.cliPath,
    testProject: config.testProject, model: 'gpt-6.1-sol', reasoning: 'ultra',
  }, null, 2) + '\n') });
  if (new Set(staging.map(row => path.resolve(row.file))).size !== staging.length || staging.some(row => !managed.allowed(row.file))) throw new Error('Overlapping or unexpected plugin destinations.');
  const priorPaths = new Set([...staging.map(row => row.file), userConfig, ...registryPaths(config.codexHome)]);
  for (const root of managed.roots) for (const file of await files(root)) priorPaths.add(file);
  if ([...priorPaths].some(file => !managed.allowed(file))) throw new Error('Unexpected snapshot target or authentication file.');
  const { install: installBridge } = require(path.join(bridgeSource, 'apply-codex-model.cjs'));
  const bridgePlan = installBridge({ appRoot: config.auraRoot, routerRoot: config.routerRoot, backupRoot, dryRun: true });
  const bridgeRestoreScript = path.resolve(bridgeSource, 'restore-codex-model.cjs');
  const restoreBytes = await read(bridgeRestoreScript);
  if (!restoreBytes) throw new Error('Missing bridge restore CLI in the package.');
  if (dryRun) return { dryRun: true, pluginRoot, catalog, configPath: config.configPath,
    stagedFiles: staging.length, snapshotFiles: priorPaths.size, bridgePlan, commands: ['codex plugin marketplace add <marketplace> --json', 'codex plugin add codex-aura@aura-local --json'] };

  const backupDir = path.join(path.resolve(backupRoot), 'Codex-Aura-Install-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(backupDir, { recursive: true });
  const manifest = { version: 1, kind: 'codex-aura', createdAt: new Date().toISOString(), ...context,
    files: [], bridgeBackup: '', bridgeRestoreScript, bridgeRestoreBackupName: 'bridge-restore.cjs', bridgeRestoreSha256: sha(restoreBytes), complete: false };
  await write(path.join(backupDir, manifest.bridgeRestoreBackupName), restoreBytes);
  for (const file of priorPaths) {
    const bytes = await read(file), backupName = `${manifest.files.length}-${path.basename(file)}`;
    if (bytes) await write(path.join(backupDir, backupName), bytes);
    manifest.files.push({ path: file, existed: bytes !== null, backupName, sha256: bytes && sha(bytes), installedSha256: null });
  }
  const saveManifest = () => write(path.join(backupDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  await saveManifest(); // All original content is recoverable before staging.
  try {
    // Codex 0.159.2's portable entry masks the compatibility MCP declaration.
    // This exact obsolete file was included in the checkpoint above. Remove it
    // only for our compatibility runtime; retain the portable reference copy.
    if (compatibilityRuntime && await read(obsoletePortableManifest)) await fs.unlink(obsoletePortableManifest);
    for (const row of staging) await write(row.file, row.bytes);
    const command = async args => {
      const { stdout } = await exec(cli.command, [...(cli.prefixArgs || []), ...args], { windowsHide: true, timeout: 60_000, maxBuffer: 2_000_000 });
      return JSON.parse(stdout);
    };
    const marketplace = await command(['plugin', 'marketplace', 'add', marketRoot, '--json']);
    const plugin = await command(['plugin', 'add', 'codex-aura@aura-local', '--json']);
    const bridge = installBridge({ appRoot: config.auraRoot, routerRoot: config.routerRoot, backupRoot, dryRun: false });
    manifest.bridgeBackup = bridge.backupDir || '';
    await saveManifest();
    for (const root of managed.roots) for (const file of await files(root)) if (!priorPaths.has(file)) {
      if (!managed.allowed(file)) throw new Error('Unexpected installed cache file.');
      manifest.files.push({ path: file, existed: false, backupName: '', sha256: null, installedSha256: null }); priorPaths.add(file);
    }
    for (const record of manifest.files) { const bytes = await read(record.path); record.installedSha256 = bytes && sha(bytes); }
    manifest.complete = true; await saveManifest();
    return { ok: true, pluginRoot, backupDir, configPath: config.configPath, marketplace, plugin, bridge,
      registrationStateCoverage: [userConfig, ...registryPaths(config.codexHome)],
      note: 'The running Codex turn keeps its existing tool catalog. Open a new turn or restart Codex to load the installed plugin.' };
  } catch (error) {
    const rollbackErrors = [];
    if (manifest.bridgeBackup) {
      try { await restoreBridge(manifest, backupDir); manifest.bridgeRolledBack = true; }
      catch (rollbackError) { rollbackErrors.push('Bridge: ' + rollbackError.message.slice(0, 500)); }
    }
    // Only files created beneath our own package directories are candidates for
    // removal. Never recursively remove a computed directory or Codex state.
    const restored = new Set(manifest.files.map(row => row.path));
    for (const root of managed.roots) {
      try { for (const file of await files(root)) if (!restored.has(file) && managed.allowed(file)) await fs.unlink(file); }
      catch (rollbackError) { rollbackErrors.push(rollbackError.message.slice(0, 500)); }
    }
    for (const row of manifest.files) {
      try {
        if (row.existed) await write(row.path, await fs.readFile(path.join(backupDir, row.backupName)));
        else if (await read(row.path)) await fs.unlink(row.path);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message.slice(0, 500)); }
    }
    manifest.complete = false; manifest.rollbackErrors = rollbackErrors;
    try { await saveManifest(); } catch (rollbackError) { rollbackErrors.push(rollbackError.message.slice(0, 500)); }
    throw new Error(`Codex-Aura installation failed; ${rollbackErrors.length ? 'some managed files need manual recovery: ' + rollbackErrors.join(' | ') : 'managed files were restored'}. Backup: ${backupDir}. ${error.message.slice(0, 1200)}`);
  }
}

export async function restore(backupDir, { dryRun = false, restoreScript } = {}) {
  backupDir = path.resolve(backupDir); await noSymlinks(backupDir);
  const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.kind !== 'codex-aura' || !manifest.complete || !Array.isArray(manifest.files)) throw new Error('This is not a completed Codex-Aura installation checkpoint.');
  const managed = managedTargets(manifest), recorded = new Set();
  for (const row of manifest.files) {
    if (!managed.allowed(row.path) || recorded.has(path.resolve(row.path))) throw new Error('Backup names an unexpected or duplicate managed target: ' + row.path);
    recorded.add(path.resolve(row.path));
    const bytes = await read(row.path);
    if ((bytes && sha(bytes)) !== row.installedSha256) throw new Error('A managed file changed after installation; retained: ' + row.path);
    if (row.existed) {
      if (!row.backupName || path.basename(row.backupName) !== row.backupName) throw new Error('Invalid backup member path.');
      if (sha(await fs.readFile(path.join(backupDir, row.backupName))) !== row.sha256) throw new Error('Backup hash mismatch: ' + row.path);
    }
  }
  for (const root of managed.roots) for (const file of await files(root)) if (!recorded.has(path.resolve(file))) throw new Error('A managed file was added after installation; retained: ' + file);
  await restoreBridge(manifest, backupDir, { dryRun: true, restoreScript });
  if (dryRun) return { dryRun: true, files: manifest.files.length, bridgeBackup: manifest.bridgeBackup };
  const recovery = path.join(path.dirname(backupDir), 'Codex-Aura-Before-Restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(recovery, { recursive: true });
  const recoveryFiles = [];
  for (const row of manifest.files) {
    const bytes = await read(row.path), backupName = `${sha(row.path)}-${path.basename(row.path)}`;
    if (bytes) await write(path.join(recovery, backupName), bytes);
    recoveryFiles.push({ path: row.path, existed: bytes !== null, backupName, sha256: bytes && sha(bytes) });
  }
  await write(path.join(recovery, 'manifest.json'), Buffer.from(JSON.stringify({ restoredFrom: backupDir, files: recoveryFiles }, null, 2)));
  const bridge = await restoreBridge(manifest, backupDir, { restoreScript });
  for (const row of manifest.files) {
    if (row.existed) await write(row.path, await fs.readFile(path.join(backupDir, row.backupName)));
    else if (await read(row.path)) await fs.unlink(row.path);
  }
  return { restored: true, files: manifest.files.length, recovery, bridge };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
  try {
    const result = args.includes('--restore') ? await restore(value('--restore'), { dryRun: args.includes('--dry-run'), restoreScript: value('--bridge-restore-script') })
      : await install({ configPath: value('--config'), backupRoot: value('--backup-root'), bridgeSource: value('--bridge-source'), dryRun: args.includes('--dry-run') });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1; }
}
