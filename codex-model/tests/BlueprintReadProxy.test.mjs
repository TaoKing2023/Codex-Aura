import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { filterBlueprintReadTools, guardBlueprintRead } from '../AuraCodexBridge.mjs';

const bridge = fileURLToPath(new URL('../AuraCodexBridge.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fake-aura-mcp.mjs', import.meta.url));
const assetPath = '/Game/Fixture/BP_Test.BP_Test';
const safeParts = ['Events', 'Functions', 'Macros', 'Interfaces', 'Components', 'CollapsedGraphs'];
const meta = (reportedPath = assetPath, kind = 'Blueprint') => ({
  content: [{ type: 'text', text: `${kind} Name: BP_Test\nPath: ${reportedPath}\nEvents: ConstructionScript\n` }],
});
const graph = { content: [{ type: 'text', text: 'Node A -> Node B: execution pin\n' }] };
function recorder(metadata = meta()) {
  const calls = [];
  return { calls, invoke: async (name, args) => {
    calls.push({ name, args });
    return name === 'get_asset_meta' ? metadata : graph;
  } };
}

test('text-only upstream connection errors are reported accurately and never invoke graph reads', async () => {
  const reply = { isError: false, content: [{ type: 'text', text: 'error: Unreal Engine is not running.' }] };
  const upstream = recorder(reply);
  const result = await guardBlueprintRead('get_asset_graph', { asset_path: assetPath, strand_names: ['Construction Script'] }, upstream.invoke);
  assert.equal(result.isError, true); assert.deepEqual(result.content, reply.content);
  assert.equal(upstream.calls.length, 1); assert.equal(upstream.calls[0].name, 'get_asset_meta');
});

test('catalog exposes only guarded Blueprint tools with fixed safety hints and constrained schemas', () => {
  const source = ['get_asset_meta', 'delete_asset', 'get_asset_graph', 'execute_unreal_python_readonly'].map((name) => ({
    name, annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: { type: 'object', properties: { unsafe: { type: 'string' } } },
  }));
  const before = structuredClone(source);
  const tools = filterBlueprintReadTools(source);
  assert.deepEqual(tools.map((tool) => tool.name), ['get_asset_meta', 'get_asset_graph']);
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(new RegExp(tool.inputSchema.properties.asset_path.pattern).test(assetPath));
    assert.equal(tool.inputSchema.properties.unsafe, undefined);
  }
  assert.deepEqual(tools[0].inputSchema.properties.parts.items.enum, safeParts);
  assert.deepEqual(tools[0].inputSchema.required, ['asset_path']);
  assert.deepEqual(tools[1].inputSchema.required, ['asset_path', 'strand_names']);
  assert.equal(tools[1].inputSchema.properties.strand_names.minItems, 1);
  assert.deepEqual(source, before, 'The source MCP catalog must not be modified');
});

test('omitted and empty metadata parts always invoke the complete safe structural set', async () => {
  for (const args of [{ asset_path: assetPath }, { asset_path: assetPath, parts: [] }]) {
    const upstream = recorder();
    const result = await guardBlueprintRead('get_asset_meta', args, upstream.invoke);
    assert.deepEqual(result, meta());
    assert.deepEqual(upstream.calls, [{ name: 'get_asset_meta', args: { asset_path: assetPath, parts: safeParts } }]);
  }
  const upstream = recorder();
  await guardBlueprintRead('get_asset_meta', { asset_path: assetPath, parts: ['Events', 'Components'] }, upstream.invoke);
  assert.deepEqual(upstream.calls[0].args.parts, ['Events', 'Components']);
});

test('property/default/material/unknown metadata parts fail before any upstream request', async () => {
  for (const parts of [['PropertyValues'], ['PropertyDeclarations'], ['Declarations'], ['MaterialParams'], ['FutureUnsafePart'],
    ['Events', 'PropertyValues'], ['Events', 1], 'Events', null, {}]) {
    const upstream = recorder();
    await assert.rejects(guardBlueprintRead('get_asset_meta', { asset_path: assetPath, parts }, upstream.invoke), /Only structural parts/);
    assert.deepEqual(upstream.calls, []);
  }
});

test('noncanonical paths, unexpected arguments and write tools are blocked without forwarding', async () => {
  for (const value of ['../BP_Test', '/Game/../BP_Test.BP_Test', '/Game/Fixture/./BP_Test.BP_Test',
    '/Game/Fixture/BP_Test', 'C:\\Game\\BP_Test.uasset', 'file:///Game/BP_Test', '/Game/Fixture/BP_Test.BP_Test:Subobject', '', null, [assetPath]]) {
    const upstream = recorder();
    await assert.rejects(guardBlueprintRead('get_asset_meta', { asset_path: value }, upstream.invoke), /canonical Unreal asset/);
    assert.deepEqual(upstream.calls, []);
  }
  for (const [name, args] of [
    ['delete_asset', { asset_path: assetPath }],
    ['execute_unreal_python_readonly', { code: 'write()' }],
    ['get_asset_meta', { asset_path: assetPath, compile: true }],
    ['get_asset_graph', { asset_path: assetPath, strand_names: ['ConstructionScript'], parts: ['PropertyValues'] }],
  ]) {
    const upstream = recorder();
    await assert.rejects(guardBlueprintRead(name, args, upstream.invoke), /guarded Blueprint|Unexpected tool argument/);
    assert.deepEqual(upstream.calls, []);
  }
});

test('graph requests require nonempty valid strand names before even metadata is requested', async () => {
  for (const strandNames of [undefined, [], '', [''], ['  '], ['ConstructionScript', null], [1], ['x'.repeat(513)]]) {
    const upstream = recorder();
    await assert.rejects(guardBlueprintRead('get_asset_graph', { asset_path: assetPath, strand_names: strandNames }, upstream.invoke), /nonempty strand_names/);
    assert.deepEqual(upstream.calls, []);
  }
});

test('wrong path, material and unverified metadata never result in a graph call', async () => {
  for (const metadata of [meta('/Game/Other/BP_Other.BP_Other'), meta(assetPath, 'Material'),
    { content: [{ type: 'text', text: `Description\nBlueprint Name: BP_Test\nPath: ${assetPath}\n` }] },
    { content: [{ type: 'text', text: 'Not a Blueprint' }] }, { content: [] }]) {
    for (const name of ['get_asset_meta', 'get_asset_graph']) {
      const upstream = recorder(metadata);
      await assert.rejects(guardBlueprintRead(name, {
        asset_path: assetPath, ...(name === 'get_asset_graph' ? { strand_names: ['ConstructionScript'] } : {}),
      }, upstream.invoke), /does not confirm this exact asset is a Blueprint/);
      assert.equal(upstream.calls.length, 1);
      assert.equal(upstream.calls[0].name, 'get_asset_meta');
      assert.deepEqual(upstream.calls[0].args.parts, safeParts);
    }
  }
});

test('validated Blueprint graph returns node links only after safe metadata and preserves exact graph arguments', async () => {
  const upstream = recorder();
  const args = { asset_path: assetPath, strand_names: ['UserConstructionScript', 'EventGraph'] };
  const result = await guardBlueprintRead('get_asset_graph', args, upstream.invoke);
  assert.deepEqual(upstream.calls, [
    { name: 'get_asset_meta', args: { asset_path: assetPath, parts: safeParts } },
    { name: 'get_asset_graph', args },
  ]);
  assert.equal(result, graph);
  assert.match(result.content[0].text, /Node A -> Node B/);
});

test('construction display aliases use the internal graph name without changing other strands or caller arguments', async () => {
  for (const alias of ['Construction Script', 'ConstructionScript']) {
    const upstream = recorder();
    const args = { asset_path: assetPath, strand_names: [alias, 'CustomFunction'] };
    await guardBlueprintRead('get_asset_graph', args, upstream.invoke);
    assert.deepEqual(upstream.calls[1].args.strand_names, ['UserConstructionScript', 'CustomFunction']);
    assert.deepEqual(args.strand_names, [alias, 'CustomFunction']);
  }
});

test('upstream metadata errors remain visible and suppress graph execution', async () => {
  const error = { isError: true, content: [{ type: 'text', text: 'Asset not found' }] };
  const upstream = recorder(error);
  const result = await guardBlueprintRead('get_asset_graph', { asset_path: assetPath, strand_names: ['EventGraph'] }, upstream.invoke);
  assert.equal(result, error);
  assert.equal(upstream.calls.length, 1);
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(40);
  }
  throw new Error('Timed out waiting for owned test process');
}
const exists = async (file) => { try { await fs.access(file); return true; } catch { return false; } };
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function stdioHarness(t, { heartbeat = false, exitAfter = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-blueprint-proxy-test-'));
  const logFile = path.join(root, 'requests.jsonl');
  const heartbeatFile = path.join(root, 'heartbeat.txt');
  const pidFile = path.join(root, 'pids.json');
  const args = [bridge, '--blueprint-read-proxy', '--command', process.execPath,
    '--arg', fixture, '--arg', '--log', '--arg', logFile, '--arg', '--pids', '--arg', pidFile];
  if (heartbeat) args.push('--arg', '--heartbeat', '--arg', heartbeatFile);
  if (exitAfter) args.push('--arg', '--exit-after', '--arg', exitAfter);
  const child = spawn(process.execPath, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', ended = false, exitCode;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', (code) => { ended = true; exitCode = code; resolve(code); }));
  const replies = [], pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    replies.push(message);
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); }
  });
  child.once('error', (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`No ${method} reply. ${stderr}`)); }, 5000);
    pending.set(requestId, { timer, resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  t.after(async () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Test cleanup')); }
    pending.clear();
    if (!ended) {
      child.stdin.end();
      await Promise.race([closed, pause(3000)]);
    }
    if (!ended) {
      if (process.platform === 'win32') {
        try { await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch { child.kill('SIGKILL'); }
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      await Promise.race([closed, pause(1000)]);
    }
    const resolvedRoot = path.resolve(root);
    assert.ok(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedRoot).startsWith('aura-blueprint-proxy-test-'));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  });
  return {
    child, request, replies, closed, heartbeatFile, pidFile,
    get ended() { return ended; }, get exitCode() { return exitCode; }, get stderr() { return stderr; },
    notification: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    requests: async () => (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

test('stdio proxy completes MCP handshake, merges paginated tools, reads graph links and refuses unsafe methods', { timeout: 15_000 }, async (t) => {
  const h = await stdioHarness(t);
  const initialized = await h.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'guard-test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  assert.match(initialized.result.instructions, /Only guarded Blueprint/);
  assert.equal(h.replies.some((reply) => reply.method === 'sampling/createMessage'), false);
  h.notification('notifications/initialized', {});
  const listed = await h.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['get_asset_meta', 'get_asset_graph']);
  assert.equal(listed.result.nextCursor, undefined);
  assert.deepEqual(listed.result.tools[0].inputSchema.properties.parts.items.enum, safeParts);
  assert.equal(listed.result.tools[1].annotations.readOnlyHint, true);

  const metadata = await h.request('tools/call', { name: 'get_asset_meta', arguments: { asset_path: assetPath } });
  assert.match(metadata.result.content[0].text, /Components: Box/);
  const nodes = await h.request('tools/call', { name: 'get_asset_graph', arguments: { asset_path: assetPath, strand_names: ['ConstructionScript'] } });
  assert.match(nodes.result.content[0].text, /Link: A\.Then -> B\.Execute/);
  assert.deepEqual((await h.request('ping')).result, {});
  const readRequests = (await h.requests()).filter((message) => message.method === 'tools/call');
  assert.deepEqual(readRequests.map((message) => message.params.name), ['get_asset_meta', 'get_asset_meta', 'get_asset_graph']);
  assert.deepEqual(readRequests[0].params.arguments.parts, safeParts);
  assert.deepEqual(readRequests[1].params.arguments.parts, safeParts);

  const before = (await h.requests()).length;
  for (const params of [
    { name: 'delete_asset', arguments: { asset_path: assetPath } },
    { name: 'get_asset_meta', arguments: { asset_path: assetPath, parts: ['PropertyValues'] } },
  ]) {
    const reply = await h.request('tools/call', params);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /aura-codex-read-only/);
  }
  const refused = await h.request('resources/read', { uri: 'file:///project/Secret' });
  assert.equal(refused.error.code, -32601);
  assert.match(refused.error.message, /Unsupported MCP method/);
  assert.equal((await h.requests()).length, before, 'Blocked requests must never reach the upstream server');
  h.child.stdin.end();
  assert.equal(await h.closed, 0);
  assert.equal(h.stderr, '');
});

test('stdio proxy refuses material and wrong-path graphs after metadata, with no graph forwarded', { timeout: 10_000 }, async (t) => {
  const h = await stdioHarness(t);
  for (const requestedPath of ['/Game/Fixture/M_Test.M_Test', '/Game/Fixture/BP_WrongPath.BP_WrongPath']) {
    const reply = await h.request('tools/call', { name: 'get_asset_graph', arguments: { asset_path: requestedPath, strand_names: ['ConstructionScript'] } });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /does not confirm this exact asset is a Blueprint/);
  }
  const error = await h.request('tools/call', { name: 'get_asset_graph', arguments: { asset_path: '/Game/Fixture/BP_Error.BP_Error', strand_names: ['ConstructionScript'] } });
  assert.equal(error.result.isError, true);
  assert.match(error.result.content[0].text, /Asset not found/);
  const reads = (await h.requests()).filter((message) => message.method === 'tools/call');
  assert.equal(reads.length, 3);
  assert.ok(reads.every((message) => message.params.name === 'get_asset_meta'));
});

test('closing the stdio client kills the controlled upstream and its heartbeat grandchild', { timeout: 12_000 }, async (t) => {
  const h = await stdioHarness(t, { heartbeat: true });
  await h.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tree-test', version: '1' } });
  await waitUntil(async () => await exists(h.heartbeatFile) && (await fs.stat(h.heartbeatFile)).size > 2);
  const pids = JSON.parse(await fs.readFile(h.pidFile, 'utf8'));
  assert.ok(isRunning(pids.upstream));
  assert.ok(isRunning(pids.worker));
  h.child.stdin.end();
  assert.equal(await h.closed, 0);
  await waitUntil(() => !isRunning(pids.upstream) && !isRunning(pids.worker));
  const stopped = (await fs.stat(h.heartbeatFile)).size;
  await pause(200);
  assert.equal((await fs.stat(h.heartbeatFile)).size, stopped);
});

test('an exited upstream fails subsequent RPC immediately without waiting for the tool timeout', { timeout: 10_000 }, async (t) => {
  const h = await stdioHarness(t, { exitAfter: 'ping' });
  assert.deepEqual((await h.request('ping')).result, {});
  const pids = JSON.parse(await fs.readFile(h.pidFile, 'utf8'));
  await waitUntil(() => !isRunning(pids.upstream));
  const start = Date.now();
  const reply = await h.request('tools/list');
  assert.match(reply.error.message, /upstream exited|upstream closed/i);
  assert.ok(Date.now() - start < 2000);
});
