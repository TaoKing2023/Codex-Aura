import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const serverFile = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/diagnostic-mcp.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t, extraArgs = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aura-server-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const mcpConfig = path.join(dir, 'mcp.json');
  const log = path.join(dir, 'calls.jsonl');
  const store = path.join(dir, 'threads.json');
  await fs.writeFile(configPath, JSON.stringify({ auraMcpConfig: mcpConfig, codexHome: path.join(dir, 'codex'), bridgeStore: store, routerUrl: 'http://127.0.0.1:1' }));
  await fs.writeFile(mcpConfig, JSON.stringify({ unreal_inspector: { command: process.execPath, args: [fixture, '--log', log, ...extraArgs] } }));
  await fs.writeFile(store, JSON.stringify({ version: 1, aliases: {}, conversations: {} }));
  const child = spawn(process.execPath, [serverFile, '--config', configPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const rawOutput = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    rawOutput.push(line);
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timer); request.resolve(message); }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { child.stdin.end(); const timeout = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timeout); lines.close(); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture MCP server response timeout')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { dir, log, store, rpc, child, exited, rawOutput, getStderr: () => stderr };
}

test('plugin MCP stdio advertises six audited read tools and responds with valid protocol JSON', async (t) => {
  const client = await setup(t);
  const init = await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.version, '0.1.5');
  const catalog = await client.rpc('tools/list');
  assert.deepEqual(catalog.result.tools.map((tool) => tool.name), ['aura_get_blueprint_meta', 'aura_get_blueprint_graph', 'aura_doctor', 'aura_permissions', 'aura_list_conversations', 'aura_read_conversation']);
  assert.ok(catalog.result.tools.every((tool) => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
  assert.doesNotMatch(JSON.stringify(catalog), /PropertyValues|MaterialParams/);
  const permissions = await client.rpc('tools/call', { name: 'aura_permissions', arguments: { mode: 'Ask', project_dir: 'E:\\Project', project_name: 'Project' } });
  assert.equal(permissions.result.structuredContent.writeAllowed, false);
  assert.equal(permissions.result.structuredContent.approvalPolicy, 'never');
  const unknown = await client.rpc('tools/call', { name: 'delete_asset', arguments: {} }); assert.equal(unknown.result.isError, true);
  const badArgs = await client.rpc('tools/call', { name: 'aura_list_conversations', arguments: { limit: -1 } }); assert.equal(badArgs.result.isError, true);
  assert.equal((await client.rpc('resources/list')).error.code, -32601);
  assert.equal(client.getStderr(), ''); assert.ok(client.rawOutput.every((line) => JSON.parse(line).jsonrpc === '2.0'));
});

test('plugin guarded Blueprint graph invokes safe metadata before graph and normalizes construction name', async (t) => {
  const client = await setup(t);
  const result = await client.rpc('tools/call', { name: 'aura_get_blueprint_graph', arguments: { asset_path: '/Game/Fixture/BP_Test.BP_Test', strand_names: ['Construction Script'] } });
  assert.equal(result.result.isError, undefined); assert.match(result.result.content[0].text, /Node A Then -> Node B Execute/);
  assert.equal(result.result.structuredContent, undefined);
  const log = (await fs.readFile(client.log, 'utf8')).trim().split('\n').map(JSON.parse);
  const calls = log.filter((request) => request.method === 'tools/call');
  assert.deepEqual(calls.map((request) => request.params.name), ['get_asset_meta', 'get_asset_graph']);
  assert.ok(!calls[0].params.arguments.parts.includes('PropertyValues'));
  assert.deepEqual(calls[1].params.arguments.strand_names, ['UserConstructionScript']);
  assert.ok(!log.some((request) => request.id === 'untrusted-sampling'));
});

test('plugin rejects compile-capable metadata before spawning and refuses Material graph after metadata', async (t) => {
  const client = await setup(t);
  const unsafe = await client.rpc('tools/call', { name: 'aura_get_blueprint_meta', arguments: { asset_path: '/Game/Fixture/BP_Test.BP_Test', parts: ['PropertyValues'] } });
  assert.equal(unsafe.result.isError, true); await assert.rejects(fs.access(client.log));
  const material = await client.rpc('tools/call', { name: 'aura_get_blueprint_graph', arguments: { asset_path: '/Game/Fixture/M_Test.M_Test', strand_names: ['MaterialGraph'] } });
  assert.equal(material.result.isError, true); assert.match(material.result.content[0].text, /Blueprint/);
  const calls = (await fs.readFile(client.log, 'utf8')).trim().split('\n').map(JSON.parse).filter((request) => request.method === 'tools/call');
  assert.deepEqual(calls.map((request) => request.params.name), ['get_asset_meta']);
});

test('plugin transmits upstream tool failure rather than wrapping it as success', async (t) => {
  const client = await setup(t);
  const response = await client.rpc('tools/call', { name: 'aura_get_blueprint_meta', arguments: { asset_path: '/Game/Fixture/BP_Error.BP_Error' } });
  assert.equal(response.result.isError, true); assert.equal(response.result.content[0].text, 'Fixture asset not found');
  assert.equal(response.result.structuredContent, undefined);
});

test('plugin EOF cancels owned upstream process tree while a Blueprint read waits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aura-heartbeat-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const heartbeat = path.join(dir, 'heartbeat');
  const client = await setup(t, ['--mode', 'hang-call', '--heartbeat', heartbeat]);
  const pending = client.rpc('tools/call', { name: 'aura_get_blueprint_meta', arguments: { asset_path: '/Game/Fixture/BP_Test.BP_Test' } });
  for (let i = 0; i < 30; i++) { try { if ((await fs.stat(heartbeat)).size > 2) break; } catch { /* wait startup */ } await delay(30); }
  assert.ok((await fs.stat(heartbeat)).size > 2);
  client.child.stdin.end();
  const result = await pending; assert.equal(result.result.isError, true);
  await client.exited;
  const size = (await fs.stat(heartbeat)).size; await delay(150);
  assert.equal((await fs.stat(heartbeat)).size, size);
});
