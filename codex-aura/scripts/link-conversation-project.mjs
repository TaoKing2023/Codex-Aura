// Assign an existing local conversation to an existing Codex project through
// public app-server APIs. The explicit desktop-workspace flag may load an idle
// thread read-only and change its default cwd. This helper never starts a turn.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveCli } from '../lib/config.mjs';
import { linkConversationProject, normalizeConversationWorkspace as absolutePath } from '../lib/app-server.mjs';
export { linkConversationProject } from '../lib/app-server.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const execFileAsync = promisify(execFile);
const METHODS = new Set(['initialize', 'project/list', 'thread/read', 'thread/metadata/update', 'thread/goal/get', 'thread/resume', 'thread/settings/update']);

async function killOwnedProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 64000 });
    } catch { child.kill(); }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function createProjectRpc({ cli, env = process.env, cwd = process.cwd(), timeoutMs = 30000 }) {
  const child = spawn(cli.command, [...(cli.prefixArgs || []), 'app-server', '--stdio'], {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0, buffer = '', failure, closing = false;
  const closed = new Promise(resolve => child.once('close', resolve));
  const fail = error => {
    failure ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure); }
    pending.clear();
  };
  const send = message => {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  child.on('error', error => fail(new Error(`Cannot start Codex app-server: ${error.code || 'process error'}.`)));
  child.on('close', () => { if (!closing) fail(new Error('Codex app-server disconnected before the project operation finished.')); });
  child.stdin.on('error', () => fail(new Error('Codex app-server input disconnected.')));
  child.stderr.on('data', () => {}); // Never print auth-bearing runtime diagnostics.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error('Codex app-server response exceeded the limit.')); void killOwnedProcess(child); return; }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('Codex app-server returned invalid JSON.')); void killOwnedProcess(child); return; }
      if (message.id !== undefined && message.method) {
        try { send({ id: message.id, error: { code: -32601, message: 'This project metadata helper does not grant approvals or execute tools.' } }); } catch { /* already failed */ }
      } else if (message.id !== undefined) {
        const entry = pending.get(message.id); if (!entry) continue;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`Codex app-server: ${message.error.message || 'RPC failed'}`));
        else entry.resolve(message.result);
      }
    }
  });
  return {
    rpc(method, params) {
      if (!METHODS.has(method)) return Promise.reject(new Error('This helper only allows existing project metadata and model-free workspace APIs.'));
      if (method === 'thread/resume' && (params?.approvalPolicy !== 'never' || params?.sandbox !== 'read-only' ||
        params?.excludeTurns !== true || Object.keys(params).some(key => !['threadId', 'approvalPolicy', 'sandbox', 'excludeTurns'].includes(key)))) {
        return Promise.reject(new Error('Workspace preparation requires a read-only, never-approval resume by existing thread id.'));
      }
      if (method === 'thread/settings/update' && Object.keys(params || {}).some(key => !['threadId', 'cwd'].includes(key))) {
        return Promise.reject(new Error('This helper may update only the conversation default working directory.'));
      }
      return new Promise((resolve, reject) => {
        if (failure) { reject(failure); return; }
        const id = ++sequence;
        const timer = setTimeout(() => {
          fail(new Error('Codex project operation timed out.'));
          void killOwnedProcess(child);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, method, params }); } catch (error) { fail(error); }
      });
    },
    initialized() { send({ method: 'initialized', params: {} }); },
    async close() {
      closing = true;
      fail(new Error('Codex project metadata connection closed.'));
      child.stdin.end();
      let timer;
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
      await killOwnedProcess(child);
      await closed;
    },
  };
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--desktop-workspace') options.desktopWorkspace = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--thread', '--workspace', '--config'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      options[{ '--thread': 'threadId', '--workspace': 'workspace', '--config': 'configPath' }[arg]] = value;
    } else throw new Error(`Unknown argument: ${arg}.`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node link-conversation-project.mjs --thread <existing UUID> --workspace <registered absolute folder> [--desktop-workspace] [--dry-run] [--config <Codex-Aura config.json>]\n');
    return;
  }
  if (!UUID.test(options.threadId || '')) throw new Error('A valid --thread UUID is required.');
  absolutePath(options.workspace);
  const config = await loadConfig({ configPath: options.configPath });
  const cli = await resolveCli(config);
  const client = createProjectRpc({ cli, env: { ...process.env, CODEX_HOME: config.codexHome } });
  try {
    await client.rpc('initialize', { clientInfo: { name: 'codex_aura', title: 'Codex-Aura', version: '0.1.5' }, capabilities: { experimentalApi: true } });
    client.initialized();
    const result = await linkConversationProject(options, { rpc: client.rpc });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
