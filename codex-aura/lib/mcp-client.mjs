// A bounded local stdio client. It never answers upstream sampling requests.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const execFileAsync = promisify(execFile);

export function createStdioClient(server, { timeoutMs = 300_000, env = process.env, signal } = {}) {
  signal?.throwIfAborted();
  if (!server || typeof server.command !== 'string' || !Array.isArray(server.args || [])) throw new Error('Invalid local MCP server configuration.');
  const child = spawn(server.command, server.args || [], { cwd: server.cwd || undefined, windowsHide: true,
    detached: process.platform !== 'win32', env: { ...env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let failure;
  let closed = false;
  let outputBytes = 0;
  const rejectPending = (error) => {
    failure = error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.stderr.on('data', () => {}); // Never expose potentially sensitive stderr.
  child.stdin.on('error', () => rejectPending(new Error('Aura MCP input closed.')));
  child.once('error', () => rejectPending(new Error('Aura MCP executable could not start.')));
  child.once('exit', () => rejectPending(new Error('Aura MCP process ended.')));
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > 24_000_000) {
      rejectPending(new Error('Aura MCP output exceeded the read limit.'));
      void close();
    }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method || message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error('Aura MCP returned a protocol error.')) : entry.resolve(message.result);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed || failure) { reject(failure || new Error('Aura MCP client is closed.')); return; }
    // The local client is deliberately incapable of calling generic write tools.
    if (!['initialize', 'ping', 'tools/list'].includes(method)
      && !(method === 'tools/call' && ['get_asset_meta', 'get_asset_graph'].includes(params?.name))) {
      reject(new Error('Unsupported read-only Aura MCP request.')); return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Aura MCP read timed out.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  async function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', abort);
    rejectPending(new Error('Aura MCP client closed.'));
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') {
        try {
          await execFileAsync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 64_000 });
        } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }
    }
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const initialize = async () => {
    const result = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-aura-blueprint-read', version: '1.0.0' } });
    if (!result?.protocolVersion || !result.serverInfo) throw new Error('Invalid Aura MCP initialization response.');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return result;
  };
  return { request, initialize, close };
}
