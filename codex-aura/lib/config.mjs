// Runtime configuration for the local Codex-Aura plugin. No auth file is read.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const MODEL = 'gpt-6.1-sol';
export const REASONING = 'ultra';

export function defaultConfig(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  const home = env.CODEX_HOME || path.join(env.USERPROFILE || os.homedir(), '.codex');
  const auraRoot = path.join(local, 'Programs', 'aura-client');
  return {
    configPath: env.CODEX_AURA_CONFIG || path.join(local, 'Aura', 'CodexAura', 'config.json'),
    auraRoot,
    auraMcpConfig: path.join(auraRoot, 'next', '.mcp-config.json'),
    routerRoot: env.CODEX_AURA_ROUTER_ROOT || '',
    routerUrl: 'http://127.0.0.1:41777',
    codexHome: home,
    bridgeStore: path.join(local, 'Aura', 'CodexBridge', 'threads.json'),
    cliPath: env.CODEX_CLI_PATH || '',
    testProject: env.CODEX_AURA_TEST_PROJECT || '',
    model: MODEL,
    reasoning: REASONING,
  };
}

export function defaultBackupRoot(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(local, 'Aura', 'CodexAura', 'backups');
}

export async function loadConfig({ configPath, env = process.env, overrides = {} } = {}) {
  const defaults = defaultConfig(env);
  const filename = path.resolve(configPath || defaults.configPath);
  let stored = {};
  let configExists = false;
  try {
    stored = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Expected a JSON object');
    configExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Codex-Aura configuration is invalid; the file was left unchanged.');
  }
  const accepted = ['auraRoot', 'auraMcpConfig', 'routerRoot', 'routerUrl', 'codexHome', 'bridgeStore', 'cliPath', 'testProject'];
  const config = { ...defaults, configPath: filename, configExists };
  for (const key of accepted) {
    const value = overrides[key] ?? stored[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid configuration field: ${key}`);
      config[key] = value;
    }
  }
  if ((overrides.auraRoot ?? stored.auraRoot) && !(overrides.auraMcpConfig ?? stored.auraMcpConfig)) {
    config.auraMcpConfig = path.join(config.auraRoot, 'next', '.mcp-config.json');
  }
  const url = new URL(config.routerUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('The Aura router must be a local HTTP endpoint without credentials.');
  }
  config.routerUrl = url.origin;
  for (const key of ['auraRoot', 'auraMcpConfig', 'codexHome', 'bridgeStore']) config[key] = path.resolve(config[key]);
  // An unset router root must stay unset; resolving it would silently select
  // the caller's working directory as an installation target.
  if (config.routerRoot) config.routerRoot = path.resolve(config.routerRoot);
  return config;
}

export function publicConfig(config) {
  const keys = ['configPath', 'configExists', 'auraRoot', 'auraMcpConfig', 'routerRoot', 'routerUrl', 'codexHome', 'bridgeStore', 'cliPath', 'testProject', 'model', 'reasoning'];
  return Object.fromEntries(keys.map((key) => [key, config[key]]));
}

export async function readAuraMcpConfig(config) {
  const value = JSON.parse(await fs.readFile(config.auraMcpConfig, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Aura MCP configuration must be a JSON object');
  const source = value.mcpServers && typeof value.mcpServers === 'object' ? value.mcpServers : value;
  const servers = [];
  for (const [name, item] of Object.entries(source)) {
    if (!item || typeof item !== 'object' || item.enabled === false) continue;
    if (typeof item.command === 'string') {
      if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== 'string'))) {
        throw new Error(`Invalid MCP arguments for ${name}`);
      }
      servers.push({ name, command: item.command, args: item.args || [], ...(item.cwd ? { cwd: item.cwd } : {}),
        env: item.env && typeof item.env === 'object' ? item.env : {} });
    } else if (typeof item.url === 'string') servers.push({ name, url: item.url });
  }
  return servers;
}

export async function commandPath(command, { env = process.env, platform = process.platform } = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return null;
  const absolute = path.isAbsolute(command) || /^[A-Za-z]:[\\/]/.test(command);
  const names = platform === 'win32' && !path.extname(command) ? [command + '.exe', command] : [command];
  const dirs = absolute || /[\\/]/.test(command) ? [''] : String(env.PATH || env.Path || '').split(path.delimiter);
  for (const dir of dirs) for (const name of names) {
    const file = dir ? path.join(dir.replace(/^"|"$/g, ''), name) : path.resolve(name);
    try { if ((await fs.stat(file)).isFile()) return file; } catch { /* try next */ }
  }
  return null;
}

export async function resolveCli(config, { env = process.env, platform = process.platform } = {}) {
  if (config.cliPath) {
    const file = await commandPath(config.cliPath, { env, platform });
    if (file) return { command: file, prefixArgs: [] };
    // Desktop updates remove their previous version directory. An installer-
    // recorded desktop executable may therefore be rediscovered, while an
    // arbitrary missing custom executable remains an actionable error.
    const desktopRoot = env.LOCALAPPDATA && path.resolve(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const relative = desktopRoot && path.relative(desktopRoot, path.resolve(config.cliPath));
    const parts = relative && relative.split(path.sep);
    const removedDesktopVersion = platform === 'win32' && parts?.length === 2
      && /^[a-f0-9]{8,64}$/i.test(parts[0]) && /^codex\.exe$/i.test(parts[1]);
    if (!removedDesktopVersion) throw new Error('The configured Codex CLI executable was not found.');
  }
  const native = await commandPath(platform === 'win32' ? 'codex.exe' : 'codex', { env, platform });
  if (native) return { command: native, prefixArgs: [] };
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const dirs = await fs.readdir(root, { withFileTypes: true });
      const versions = [];
      for (const dir of dirs.filter((entry) => entry.isDirectory())) {
        const file = path.join(root, dir.name, 'codex.exe');
        if (await commandPath(file, { env, platform })) versions.push({ file, modified: (await fs.stat(path.dirname(file))).mtimeMs });
      }
      versions.sort((a, b) => b.modified - a.modified);
      if (versions[0]) return { command: versions[0].file, prefixArgs: [] };
    } catch { /* desktop CLI may not be installed */ }
  }
  // Run npm's JS entry directly instead of a shell command shim.
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try { if ((await fs.stat(entry)).isFile()) return { command: process.execPath, prefixArgs: [entry] }; } catch { /* next */ }
  }
  throw new Error('Codex CLI is not installed; install it and sign in, or configure cliPath.');
}

// Aura owns these publication files. Read only their known public fields; never
// inspect session.json, refresh_token.txt, session_token.txt or .env contents.
export async function readEnginePublication(config) {
  const shared = path.join(config.auraRoot, '.Aura');
  const portFile = path.join(shared, 'aura_server_port.txt');
  const projectFile = path.join(shared, 'last_connected_project.json');
  let port = null;
  let projectPath = '';
  let pid = null;
  let timestamp = '';
  let portState = 'missing';
  let projectState = 'missing';
  try {
    if ((await fs.stat(portFile)).size > 64) throw new Error('Invalid port publication');
    const raw = (await fs.readFile(portFile, 'utf8')).trim();
    if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error('Invalid port publication');
    port = Number(raw); portState = 'published';
  } catch (error) { if (error.code !== 'ENOENT') portState = 'invalid'; }
  try {
    if ((await fs.stat(projectFile)).size > 64_000) throw new Error('Invalid project publication');
    const value = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    if (!value || typeof value !== 'object' || typeof value.projectPath !== 'string' || !/\.uproject$/i.test(value.projectPath)
      || value.projectPath.includes('\0') || !Number.isInteger(value.pid) || value.pid < 1) throw new Error('Invalid project publication');
    projectPath = value.projectPath; pid = value.pid;
    timestamp = typeof value.timestamp === 'string' ? value.timestamp : '';
    projectState = 'published';
  } catch (error) { if (error.code !== 'ENOENT') projectState = 'invalid'; }
  return { source: 'Aura-owned publication files', portFile, projectFile, portState, projectState,
    port, endpoint: port ? `http://127.0.0.1:${port}` : '', projectPath, pid, timestamp, connectionVerified: false };
}

// Read only known scalar settings, never auth.json or complete TOML content.
export async function readCodexSettings(config) {
  let raw;
  try { raw = await fs.readFile(path.join(config.codexHome, 'config.toml'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const top = raw.split(/^\s*\[/m)[0];
  const result = {};
  for (const key of ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode']) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\r\\n]+)"`, 'm').exec(top);
    if (match) result[key] = match[1];
  }
  return result;
}
