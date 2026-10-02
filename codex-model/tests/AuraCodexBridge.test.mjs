import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCodexBridge, extractAuraTurn, codexModePolicy, resolveCodexCli } from '../AuraCodexBridge.mjs';

const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  text = '';
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(text) { this.text += text; return true; }
  end() { this.writableEnded = true; this.emit('close'); }
  disconnect() { this.destroyed = true; this.emit('close'); }
  parts() { return this.text.split('\n\n').filter((x) => x.startsWith('data: ') && x !== 'data: [DONE]').map((x) => JSON.parse(x.slice(6))); }
  answer() { return this.parts().filter((p) => p.type === 'text-delta').map((p) => p.delta).join(''); }
}
async function harness(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-codex-test-'));
  const projectDir = path.join(root, 'project'), storeRoot = path.join(root, 'store'), log = path.join(root, 'fake.jsonl');
  await fs.mkdir(projectDir);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const defaults = {
    backend: 'exec', // Preserve and verify the explicit legacy/ephemeral transport.
    storeRoot, fallbackCwd: projectDir,
    cli: { command: process.execPath, prefixArgs: [fixture] },
    detectProject: () => ({ dir: projectDir, name: 'Test' }),
    auraMcpServers: (mode) => mode === 'none' ? [] : [{ name: 'unreal_editor', command: process.execPath, args: mode === 'ro' ? ['readonly-proxy.mjs'] : ['editor.mjs'], env: [] }],
    ...extra,
    env: { FAKE_CODEX_LOG: log, ...extra.env },
  };
  const bridge = createCodexBridge(defaults);
  return { root, projectDir, storeRoot, log, defaults, bridge,
    execs: async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter((r) => r.kind === 'exec') };
}
const request = (extra = {}) => ({
  model: 'Codex', mode: 'analyze', creationKey: 'tab-one', projectId: 'project-one', turnId: 'turn-one',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Explain this Blueprint.' }] }], ...extra,
});

test('native conversation workspace follows the user home, configured root and explicit override', async (t) => {
  const userHome = path.join(os.tmpdir(), 'public-aura-user');
  const envRoot = path.join(os.tmpdir(), 'public-aura-conversations');
  const explicitRoot = path.join(os.tmpdir(), 'public-aura-override');
  for (const [extra, expected] of [
    [{ env: { USERPROFILE: userHome, CODEX_AURA_CONVERSATION_ROOT: undefined } }, path.join(userHome, 'Codex-Aura', 'Test')],
    [{ env: { USERPROFILE: userHome, CODEX_AURA_CONVERSATION_ROOT: envRoot } }, path.join(envRoot, 'Test')],
    [{ env: { CODEX_AURA_CONVERSATION_ROOT: envRoot }, conversationProjectRoot: explicitRoot }, path.join(explicitRoot, 'Test')],
    [{ conversationProjectRoot: '' }, undefined],
  ]) {
    let actual;
    const h = await harness(t, { ...extra, backend: 'native', runAppServerTurn: async options => {
      actual = options.conversationWorkspace;
      await options.onThread('11111111-1111-7111-8111-111111111111', { source: 'vscode' });
      options.emitText('Workspace verified'); return { answer: 'Workspace verified', threadId: '11111111-1111-7111-8111-111111111111' };
    } });
    assert.equal((await h.bridge.respondFromCodex(new Response(), {}, request())).ok, true);
    assert.equal(actual, expected);
  }
});

test('normal native turns keep actual user input distinct and preserve aliases, model and project guard', async t => {
  const calls = [], threadId = '22222222-2222-7222-8222-222222222222';
  const h = await harness(t, { backend: 'native', resolvePolicy: () => ({ guarded: true, pool: 'ro', mcp: 'ro' }),
    runAppServerTurn: async options => {
      calls.push(options);
      await options.onThread(threadId, { source: 'vscode' });
      options.emitText('Native answer');
      return { answer: 'Native answer', threadId, source: 'vscode' };
    } });
  const first = new Response();
  const r1 = await h.bridge.respondFromCodex(first, {}, request({ mode: 'agentic', projectMemory: 'Quoted project context' }), () => {}, {
    commitTurnToCloud: async () => ({ threadId: 'native-cloud', headSeq: 2, created: true,
      seqs: [{ id: 'native-u', role: 'user', seq: 1, kind: 'user' }, { id: 'native-a', role: 'assistant', seq: 2, kind: 'assistant' }] }),
  });
  assert.equal(r1.ok, true); assert.equal(first.answer(), 'Native answer');
  await h.bridge.respondFromCodex(new Response(), {}, request({ creationKey: undefined, cloudThreadId: 'native-cloud' }));
  assert.equal(calls[0].userText, 'Explain this Blueprint.');
  assert.match(calls[0].developerInstructions, /Quoted project context/);
  assert.match(calls[0].developerInstructions, /no permission to modify/);
  assert.ok(!calls[0].args.includes('exec'));
  assert.ok(calls[0].args.includes('approval_policy="never"'));
  assert.equal(calls[0].model, 'gpt-6.1-sol'); assert.equal(calls[0].reasoning, 'ultra');
  assert.equal(calls[0].policy.sandbox, 'read-only');
  assert.equal(calls[1].threadId, threadId);
  assert.ok(!calls[1].developerInstructions.includes('Previous conversation'));
  const state = JSON.parse(await fs.readFile(h.bridge.storeFile, 'utf8'));
  assert.equal(Object.keys(state.conversations).length, 1);
  assert.equal(Object.values(state.conversations)[0].source, 'vscode');
  assert.equal(first.parts().find(p => p.type === 'data-aura-codex-thread').data.threadId, threadId);
});

test('native migration preserves the original thread id and refuses an unrelated replacement', async t => {
  const oldId = '33333333-3333-7333-8333-333333333333', newId = '44444444-4444-7444-8444-444444444444';
  let turn = 0;
  const h = await harness(t, { backend: 'native', runAppServerTurn: async options => {
    const id = turn++ === 0 ? oldId : newId;
    await options.onThread(id, { source: 'vscode', ...(id === newId ? { previousThreadId: oldId } : {}) });
    options.emitText('Continued'); return { answer: 'Continued', threadId: id };
  } });
  await h.bridge.respondFromCodex(new Response(), {}, request());
  assert.equal((await h.bridge.respondFromCodex(new Response(), {}, request())).ok, true);
  const state = JSON.parse(await fs.readFile(h.bridge.storeFile, 'utf8'));
  const record = Object.values(state.conversations)[0];
  assert.equal(record.threadId, newId); assert.deepEqual(record.previousThreadIds, [oldId]);
  const failure = await h.bridge.respondFromCodex(new Response(), {}, request(), () => {}, {
    runAppServerTurn: async options => { await options.onThread(oldId, { source: 'vscode' }); throw new Error('Must not reach turn'); },
  });
  assert.equal(failure.ok, false); assert.match(failure.error, /不同的会话 ID/);
  assert.equal(Object.values(JSON.parse(await fs.readFile(h.bridge.storeFile, 'utf8')).conversations)[0].threadId, newId);
});

test('real JSONL chunk parsing, exact cloud commit ordering, thread/cloud aliases and restart continuity', async (t) => {
  const h = await harness(t);
  const first = new Response();
  let committed;
  const r1 = await h.bridge.respondFromCodex(first, {}, request(), () => {}, { commitTurnToCloud: async (value) => {
    committed = value;
    assert.equal(first.text.includes('[DONE]'), false);
    return { threadId: 'cloud-thread-one', headSeq: 2, created: true,
      seqs: [{ id: 'u', role: 'user', seq: 1, kind: 'user' }, { id: 'a', role: 'assistant', seq: 2, kind: 'assistant' }] };
  } });
  assert.equal(r1.ok, true);
  assert.equal(first.answer(), '你好 new');
  assert.equal(committed.model, 'Codex');
  assert.equal(committed.turnId, 'turn-one');
  assert.equal(first.parts().find((p) => p.type === 'data-aura-commit').data.commitStatus, 'committed');
  const receipt = first.parts().find((p) => p.type === 'data-aura-commit').data;
  assert.equal(receipt.turnId, 'turn-one');
  assert.equal(receipt.threadCreated, true);
  assert.equal(receipt.headSeq, 2);
  assert.deepEqual(receipt.seqs, [{ id: 'u', role: 'user', seq: 1, kind: 'user' }, { id: 'a', role: 'assistant', seq: 2, kind: 'assistant' }]);
  assert.ok(first.text.indexOf('data-aura-commit') < first.text.indexOf('[DONE]'));
  assert.deepEqual(await fs.readdir(h.projectDir), []);
  const restarted = createCodexBridge(h.defaults);
  const second = new Response();
  const r2 = await restarted.respondFromCodex(second, {}, request({ creationKey: undefined, cloudThreadId: 'cloud-thread-one', turnId: 'turn-two', mode: 'agentic' }));
  assert.equal(r2.threadId, r1.threadId);
  assert.equal(second.answer(), '你好 continued');
  const calls = await h.execs();
  assert.ok(calls[1].args.includes('resume'));
  assert.ok(calls[1].args.includes(r1.threadId));
  assert.ok(calls[1].args.includes('sandbox_mode="workspace-write"'));
  assert.ok(calls[1].args.includes('approval_policy="never"'));
  assert.ok(calls[1].args.includes('model="gpt-6.1-sol"'));
  assert.ok(calls[1].args.includes('model_reasoning_effort="ultra"'));
  assert.ok(!calls[1].args.includes('--last'));
  assert.ok(!calls[1].args.includes('--model'));
  assert.equal(calls[0].cwd, h.projectDir);
  const state = JSON.parse(await fs.readFile(h.bridge.storeFile, 'utf8'));
  assert.equal(Object.keys(state.conversations).length, 1);
  assert.equal(Object.keys(state.aliases).length, 2);
  assert.equal(Object.values(state.conversations)[0].history.length, 4);
});

test('MCP config is replaced per mode; unknown mode uses readonly proxy and tools-off mounts none', async (t) => {
  const h = await harness(t);
  await h.bridge.respondFromCodex(new Response(), {}, request({ mode: 'unknown', projectId: undefined }));
  await h.bridge.respondFromCodex(new Response(), {}, request({ creationKey: 'tab-two', mode: 'agentic', activeTool: false, projectId: undefined }));
  const calls = await h.execs();
  assert.ok(calls[0].args.includes('sandbox_mode="read-only"'));
  const overrides = calls[0].args.find((a) => a.startsWith('mcp_servers='));
  for (const name of ['code-review', 'node_repl', 'unreal_editor', 'unreal_inspector']) {
    assert.ok(overrides.includes(`"${name}"={"command"=`));
  }
  assert.match(overrides, /"args"=\[\],"enabled"=false/);
  assert.ok(calls[0].args.some((a) => a.includes('readonly-proxy.mjs')));
  assert.ok(!calls[1].args.some((a) => a.includes('aura_codex_')));
  for (const call of calls) {
    const serverConfig = call.args.find(argument => argument.startsWith('mcp_servers='));
    assert.ok(serverConfig.includes('"codex_apps"={"command"='));
    assert.match(serverConfig, /"codex_apps"=\{"command"=.*?,"args"=\[\],"enabled"=false\}/);
    const plugins = call.args.find(argument => argument.startsWith('plugins='));
    assert.ok(plugins.includes('"codex-aura@aura-local"={"enabled"=false}'));
    assert.ok(plugins.includes('"untrusted-write@fixture"={"enabled"=false}'));
    assert.ok(!plugins.includes('uninstalled@fixture'));
  }
  assert.ok(calls[1].args.includes('sandbox_mode="read-only"'));
  assert.match(calls[1].prompt, /user disabled tools/i);
});

test('installed Codex parses the exact generated MCP override keys without creating quoted server names', async (t) => {
  let cli;
  try { cli = await resolveCodexCli(); }
  catch { t.skip('No native Codex CLI available for read-only config-parser regression'); return; }
  const h = await harness(t);
  await h.bridge.respondFromCodex(new Response(), {}, request({ projectId: undefined }));
  const generated = (await h.execs())[0].args;
  const rootFlags = generated.slice(0, generated.indexOf('exec'));
  const { stdout } = await promisify(execFile)(cli.command, [...(cli.prefixArgs || []), ...rootFlags, 'mcp', 'list', '--json'],
    { windowsHide: true, timeout: 15_000, maxBuffer: 2_000_000 });
  const servers = JSON.parse(stdout);
  const replacement = servers.find((s) => s.name.startsWith('aura_codex_'));
  assert.equal(replacement.enabled, true);
  assert.ok(replacement.transport.args.includes('readonly-proxy.mjs'));
  assert.ok(servers.every((s) => !s.name.includes('"')));
  assert.equal(servers.find((s) => s.name === 'code-review')?.enabled, false);
  assert.equal(servers.find((s) => s.name === 'unreal_editor')?.enabled, false);
  assert.equal(servers.find((s) => s.name === 'codex_apps')?.enabled, false);
});

test('only guarded Blueprint reads receive explicit approvals; full and unrelated servers do not', async (t) => {
  const h = await harness(t, { auraMcpServers: () => [
    { name: 'unreal_inspector', command: process.execPath, args: ['readonly-proxy.mjs'] },
    { name: 'unreal_editor', command: process.execPath, args: ['editor.mjs'] },
    { name: 'unknown_server', command: process.execPath, args: ['other.mjs'] },
  ] });
  await h.bridge.respondFromCodex(new Response(), {}, request({ projectId: undefined }));
  await h.bridge.respondFromCodex(new Response(), {}, request({ creationKey: 'agent', mode: 'agentic', projectId: undefined }));
  const calls = await h.execs();
  const ro = calls[0].args.find((a) => a.startsWith('mcp_servers='));
  const full = calls[1].args.find((a) => a.startsWith('mcp_servers='));
  assert.ok(ro.includes('--blueprint-read-proxy'));
  assert.ok(ro.includes('"get_asset_meta"={"approval_mode"="approve"}'));
  assert.ok(ro.includes('"get_asset_graph"={"approval_mode"="approve"}'));
  assert.ok(ro.includes('"get_blueprint_properties"={"approval_mode"="approve"}'));
  assert.ok(!ro.includes('"default_tools_approval_mode"="approve"'));
  assert.ok(!ro.includes('"edit_blueprint"') && !ro.includes('"execute_unreal_python_readonly"'));
  assert.ok(!full.includes('--blueprint-read-proxy'));
  assert.ok(!full.includes('"get_asset_meta"={') && !full.includes('"get_asset_graph"={'));
  const other = ro.slice(ro.indexOf('"aura_codex_unknown_server_2"'));
  assert.ok(!other.includes('"approval_mode"'));
});

test('extracts visible text, hidden asset context and prior history; rejects attachments explicitly', () => {
  const body = request({ messages: [
    { role: 'user', parts: [{ type: 'text', text: '<ProcessingInstructions>mode envelope</ProcessingInstructions>' }] },
    { role: 'user', parts: [{ type: 'text', text: '<USER_MESSAGE>Old question</USER_MESSAGE>' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Old answer' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Blueprint BP_Test', isHiddenInUI: true }, { type: 'text', text: 'Real question' }] },
  ] });
  const turn = extractAuraTurn(body);
  assert.equal(turn.userText, 'Real question');
  assert.ok(turn.context.includes('Blueprint BP_Test'));
  assert.deepEqual(turn.history, [{ role: 'user', text: 'Old question' }, { role: 'assistant', text: 'Old answer' }]);
  assert.throws(() => extractAuraTurn(request({ attachments: [{ type: 'file', url: 'image.png' }] })), /暂不支持/);
  const separate = extractAuraTurn({ ...body, userMessage: { parts: [{ type: 'text', text: 'hidden context', isHiddenInUI: true }, { type: 'text', text: 'Shown text' }] }, projectMemory: 'Project notes', systemPrompt: 'Aura system context' });
  assert.equal(separate.userText, 'Shown text');
  assert.ok(separate.context.some((s) => s.includes('Project notes')));
  assert.ok(separate.context.some((s) => s.includes('Aura system context')));
  assert.equal(codexModePolicy({ mode: 'plan' }).sandbox, 'read-only');
});

test('first Codex turn in an existing cloud chat seeds history only once', async (t) => {
  const h = await harness(t);
  let loads = 0;
  const opts = { readCloudHistory: async ({ cloudThreadId }) => {
    loads++;
    assert.equal(cloudThreadId, 'existing-cloud');
    return [{ role: 'user', parts: [{ type: 'text', text: 'Remember number 1234' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'I remember 1234' }] }];
  } };
  const body = request({ creationKey: undefined, cloudThreadId: 'existing-cloud', projectId: undefined });
  await h.bridge.respondFromCodex(new Response(), {}, body, () => {}, opts);
  await h.bridge.respondFromCodex(new Response(), {}, body, () => {}, opts);
  const calls = await h.execs();
  assert.match(calls[0].prompt, /Remember number 1234/);
  assert.doesNotMatch(calls[1].prompt, /Previous conversation/);
  assert.equal(loads, 1);
});

test('existing cloud thread id is forwarded to the cloud commit callback', async (t) => {
  const h = await harness(t);
  let payload;
  await h.bridge.respondFromCodex(new Response(), {}, request({ creationKey: undefined, cloudThreadId: 'existing-thread' }), () => {}, {
    cloudProjectDir: path.join(h.root, 'CloudHistory'),
    commitTurnToCloud: async (value) => { payload = value; return { threadId: 'existing-thread', headSeq: 4 }; },
  });
  assert.equal(payload.cloudThreadId, 'existing-thread');
  assert.equal(payload.projectDir, path.join(h.root, 'CloudHistory'));
});

test('CLI errors are visible, not committed; attachments never launch inference', async (t) => {
  const h = await harness(t, { env: { FAKE_CODEX_SCENARIO: 'exit' } });
  let commits = 0;
  const res = new Response();
  const result = await h.bridge.respondFromCodex(res, {}, request(), () => {}, { commitTurnToCloud: () => { commits++; } });
  assert.equal(result.ok, false);
  assert.match(res.answer(), /Login expired/);
  assert.equal(commits, 0);
  assert.equal(res.parts().find((p) => p.type === 'data-aura-commit').data.commitStatus, 'failed');
  const receipt = res.parts().find((p) => p.type === 'data-aura-commit').data;
  assert.equal(receipt.turnId, 'turn-one');
  assert.equal(receipt.headSeq, 0);
  assert.deepEqual(receipt.seqs, []);
  assert.equal(receipt.threadCreated, false);
  const bad = new Response();
  await h.bridge.respondFromCodex(bad, {}, request({ attachments: [{ type: 'file' }] }));
  assert.match(bad.answer(), /暂不支持/);
  assert.equal((await h.execs()).length, 1);
});

test('project scope separates identical conversation ids and probes are not persisted', async (t) => {
  const h = await harness(t);
  await h.bridge.respondFromCodex(new Response(), {}, request({ projectId: 'first' }));
  await h.bridge.respondFromCodex(new Response(), {}, request({ projectId: 'second' }));
  const before = await fs.readFile(h.bridge.storeFile, 'utf8');
  let commits = 0;
  await h.bridge.respondFromCodex(new Response(), {}, request({ mode: 'agentic' }), () => {}, { noArchive: true, commitTurnToCloud: () => { commits++; } });
  assert.equal(await fs.readFile(h.bridge.storeFile, 'utf8'), before);
  assert.equal(commits, 0);
  const calls = await h.execs();
  assert.ok(!calls[0].args.includes('resume') && !calls[1].args.includes('resume'));
  assert.ok(calls[2].args.includes('--ephemeral'));
  assert.ok(calls[2].args.includes('sandbox_mode="read-only"'));
  assert.ok(!calls[2].args.some((a) => a.includes('aura_codex_')));
});

test('malformed cloud receipts cannot claim a saved conversation or discard the native answer', async t => {
  const nativeId = '55555555-5555-7555-8555-555555555555';
  const h = await harness(t, { backend: 'native', runAppServerTurn: async options => {
    await options.onThread(nativeId, { source: 'vscode' });
    options.emitText('Persisted native answer');
    return { answer: 'Persisted native answer', threadId: nativeId };
  } });
  const malformed = [
    { threadId: 'invalid-cloud', headSeq: null, seqs: [] },
    { threadId: 'invalid-cloud', headSeq: 2, seqs: [{ id: 'u', seq: 1 }] },
    { threadId: '', headSeq: 2, seqs: [] },
    { threadId: 'invalid-cloud', headSeq: 2, seqs: [{ id: 'u', role: 'system', seq: 1, kind: 'user' }] },
  ];
  for (let i = 0; i < malformed.length; i++) {
    const response = new Response(), events = [];
    const result = await h.bridge.respondFromCodex(response, {}, request({ creationKey: `malformed-${i}` }), e => events.push(e), {
      commitTurnToCloud: async () => malformed[i],
    });
    assert.equal(result.ok, true);
    assert.equal(response.answer(), 'Persisted native answer');
    const receipt = response.parts().find(p => p.type === 'data-aura-commit').data;
    assert.deepEqual({ turnId: receipt.turnId, threadId: receipt.threadId, commitStatus: receipt.commitStatus,
      headSeq: receipt.headSeq, seqs: receipt.seqs, threadCreated: receipt.threadCreated },
      { turnId: 'turn-one', threadId: '', commitStatus: 'failed', headSeq: 0, seqs: [], threadCreated: false });
    assert.ok(events.some(e => e.kind === 'codex-cloud-commit-error' && e.message.includes('提交记录格式无效')));
    assert.ok(response.text.indexOf('data-aura-commit') < response.text.indexOf('[DONE]'));
  }
  const state = JSON.parse(await fs.readFile(h.bridge.storeFile, 'utf8'));
  assert.ok(Object.values(state.conversations).every(record => record.history.length === 2 && record.threadId === nativeId));
  assert.ok(!Object.keys(state.aliases).some(alias => alias.endsWith(':invalid-cloud')));
});

test('cloud storage exceptions preserve completed native history and emit a valid failure receipt', async t => {
  const nativeId = '66666666-6666-7666-8666-666666666666';
  const h = await harness(t, { backend: 'native', runAppServerTurn: async options => {
    await options.onThread(nativeId, { source: 'vscode' });
    options.emitText('Completed answer'); return { answer: 'Completed answer', threadId: nativeId };
  } });
  const response = new Response(), events = [];
  const result = await h.bridge.respondFromCodex(response, {}, request(), e => events.push(e), {
    commitTurnToCloud: async () => { throw new Error('Aura store HTTP 503'); },
  });
  assert.equal(result.ok, true);
  assert.equal(response.answer(), 'Completed answer');
  assert.ok(events.some(e => e.kind === 'codex-cloud-commit-error' && e.message === 'Aura store HTTP 503'));
  const receipt = response.parts().find(p => p.type === 'data-aura-commit').data;
  assert.equal(receipt.commitStatus, 'failed'); assert.equal(receipt.headSeq, 0); assert.equal(receipt.threadCreated, false);
  assert.equal(receipt.turnId, 'turn-one'); assert.deepEqual(receipt.seqs, []);
  const state = JSON.parse(await fs.readFile(h.bridge.storeFile, 'utf8'));
  assert.equal(Object.values(state.conversations)[0].history.at(-1).text, 'Completed answer');
});

test('cancellation kills the CLI process tree and releases per-conversation concurrency', async (t) => {
  const h = await harness(t);
  const heartbeat = path.join(h.root, 'heartbeat.txt');
  const res = new Response();
  const first = h.bridge.respondFromCodex(res, {}, request({ projectId: undefined }), () => {}, {
    env: { FAKE_CODEX_LOG: h.log, FAKE_CODEX_SCENARIO: 'hang', FAKE_CODEX_HEARTBEAT: heartbeat },
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if ((await fs.stat(heartbeat)).size > 2) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok((await fs.stat(heartbeat)).size > 2);
  const duplicate = new Response();
  const dup = await h.bridge.respondFromCodex(duplicate, {}, request({ projectId: undefined }));
  assert.equal(dup.ok, false);
  assert.match(duplicate.answer(), /正在处理这个对话/);
  res.disconnect();
  const cancelled = await first;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /取消/);
  const stoppedSize = (await fs.stat(heartbeat)).size;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await fs.stat(heartbeat)).size, stoppedSize);
  const follow = await h.bridge.respondFromCodex(new Response(), {}, request({ projectId: undefined }));
  assert.equal(follow.ok, true);
});
