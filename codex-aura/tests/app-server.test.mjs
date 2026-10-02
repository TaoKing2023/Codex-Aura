import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAppServerTurn } from '../lib/app-server.mjs';

const fake = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const THREAD = '11111111-1111-7111-8111-111111111111';
const OLD_THREAD = '33333333-3333-7333-8333-333333333333';
const PROJECT = '44444444-4444-7444-8444-444444444444';
const CONVERSATION_WORKSPACE = 'D:\\Codex\\Test';
async function fixture(t, scenario = 'success') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-app-server-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'rpc.jsonl'), pidFile = path.join(dir, 'child.pid'), historyFile = path.join(dir, 'history.json');
  return { dir, logFile, pidFile, historyFile, options: { cli: { command: process.execPath, prefixArgs: [fake] },
    cwd: dir, args: ['-c', 'mcp_servers={}'], userText: 'Actual user request', developerInstructions: 'Read-only developer context.',
    model: 'gpt-6.1-sol', reasoning: 'ultra', policy: { sandbox: 'read-only' }, timeoutMs: 5000,
    env: { ...process.env, FAKE_APP_SCENARIO: scenario, FAKE_APP_LOG: logFile, FAKE_APP_CHILD_PID: pidFile,
      FAKE_APP_CWD: dir, FAKE_APP_HISTORY_FILE: historyFile } },
    readLog: async () => (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('starts a native thread with honest identity, distinct user context, fixed model, and deduplicated streaming', async t => {
  const f = await fixture(t), events = [], text = [];
  const result = await runAppServerTurn({ ...f.options, onEvent: e => events.push(e), onText: s => text.push(s) });
  assert.equal(result.answer, 'Hello world'); assert.equal(result.source, 'vscode');
  assert.equal(text.join(''), 'Hello world');
  const calls = await f.readLog();
  assert.equal(calls[0].params.clientInfo.name, 'codex_aura');
  assert.equal(calls[0].params.clientInfo.version, '0.1.5');
  const start = calls.find(v => v.method === 'thread/start').params;
  assert.equal(start.developerInstructions, 'Read-only developer context.');
  assert.equal(start.approvalPolicy, 'never'); assert.equal(start.sandbox, 'read-only');
  assert.equal(start.config.model_reasoning_effort, 'ultra'); assert.equal(start.model, 'gpt-6.1-sol');
  const turn = calls.find(v => v.method === 'turn/start').params;
  assert.deepEqual(turn.input, [{ type: 'text', text: 'Actual user request' }]);
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.ok(calls.some(v => v.method === 'thread/name/set'));
  assert.ok(events.some(e => e.type === 'item.completed' && e.item.type === 'mcp_tool_call'));
  assert.ok(events.some(e => e.type === 'turn.completed'));
});

test('resumes the exact original thread and preserves its source', async t => {
  const f = await fixture(t);
  const result = await runAppServerTurn({ ...f.options, threadId: THREAD, migrateLegacy: false });
  assert.equal(result.threadId, THREAD); assert.equal(result.source, 'exec');
  const calls = await f.readLog(); assert.ok(calls.some(v => v.method === 'thread/resume'));
  assert.ok(!calls.some(v => v.method === 'thread/name/set'));
});

test('migrates legacy exec history through native fork and persists both ids before the next turn', async t => {
  const f = await fixture(t); let prior;
  const result = await runAppServerTurn({ ...f.options, threadId: OLD_THREAD, onThread: async (id, summary) => {
    assert.equal(id, THREAD); prior = summary.previousThreadId;
    assert.ok(!(await f.readLog()).some(v => v.method === 'turn/start'));
  } });
  assert.equal(prior, OLD_THREAD); assert.equal(result.previousThreadId, OLD_THREAD); assert.equal(result.source, 'vscode');
  const calls = await f.readLog(), fork = calls.find(v => v.method === 'thread/fork').params;
  assert.equal(fork.threadId, OLD_THREAD); assert.equal(fork.deferGoalContinuation, true);
  assert.equal(fork.developerInstructions, f.options.developerInstructions); assert.equal(fork.sandbox, 'read-only');
  assert.ok(!calls.some(v => v.method === 'thread/resume'));
  assert.equal(calls.find(v => v.method === 'turn/start').params.threadId, THREAD);
});

test('resumes existing interactive threads without duplicating native history', async t => {
  const f = await fixture(t); await runAppServerTurn({ ...f.options, threadId: THREAD });
  const calls = await f.readLog(); assert.ok(calls.some(v => v.method === 'thread/read'));
  assert.ok(calls.some(v => v.method === 'thread/resume')); assert.ok(!calls.some(v => v.method === 'thread/fork'));
});

test('does not start inference if a migration fork keeps a hidden source', async t => {
  const f = await fixture(t, 'hidden-fork');
  await assert.rejects(runAppServerTurn({ ...f.options, threadId: OLD_THREAD }), /interactive migration/);
  assert.ok(!(await f.readLog()).some(v => v.method === 'turn/start'));
});

test('awaits persisted thread mapping before starting model turn', async t => {
  const f = await fixture(t); let recorded = false;
  await runAppServerTurn({ ...f.options, onThread: async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!(await f.readLog()).some(v => v.method === 'turn/start')); recorded = true;
  }, onText: () => assert.equal(recorded, true) });
});

test('does not turn interactive requests into automatic approvals', async t => {
  const f = await fixture(t, 'approval'); await runAppServerTurn(f.options);
  const calls = await f.readLog(); assert.deepEqual(calls.find(v => v.id === 'approval1').result, { decision: 'decline' });
});

for (const [scenario, expected] of [['disconnect', /disconnected/], ['failed', /Inference denied/], ['invalid', /JSON/], ['wrong-resume', /unexpected thread/]]) {
  test(`fails visibly on ${scenario}`, async t => {
    const f = await fixture(t, scenario);
    await assert.rejects(runAppServerTurn({ ...f.options, ...(scenario === 'wrong-resume' ? { threadId: THREAD } : {}) }), expected);
  });
}

test('cancellation ends its owned child process tree and does not return partial success', async t => {
  const f = await fixture(t, 'cancel'), controller = new AbortController();
  const result = runAppServerTurn({ ...f.options, signal: controller.signal });
  for (let i = 0; i < 100; i++) { if (await fs.stat(f.pidFile).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const pid = Number(await fs.readFile(f.pidFile, 'utf8')); controller.abort();
  await assert.rejects(result, /取消/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0));
});

test('times out a disconnected or hanging server without relaxing policies', async t => {
  const f = await fixture(t, 'timeout');
  await assert.rejects(runAppServerTurn({ ...f.options, timeoutMs: 150 }), /超时/);
});

test('rejects full access or an invalid resume id before spawn', async t => {
  const f = await fixture(t);
  await assert.rejects(runAppServerTurn({ ...f.options, policy: { sandbox: 'danger-full-access' } }), /sandbox/);
  await assert.rejects(runAppServerTurn({ ...f.options, threadId: 'not-a-uuid' }), /thread ID/);
  await assert.rejects(runAppServerTurn({ ...f.options, signal: AbortSignal.abort() }), /取消/);
});

for (const [lifecycle, resumeOptions, expectedStart, scenario = 'project-exists'] of [
  ['new', {}, 'thread/start'], ['resumed', { threadId: THREAD, migrateLegacy: false }, 'thread/resume'],
  ['migrated', { threadId: OLD_THREAD }, 'thread/fork'], ['lazy first', {}, 'thread/start', 'lazy-rollout'],
  ['lazy first with asynchronous rollout', {}, 'thread/start', 'lazy-rollout-lag'],
  ['lazy migration', { threadId: OLD_THREAD }, 'thread/fork', 'lazy-fork'],
]) {
  test(`records a ${lifecycle} conversation before inference and binds its project after native persistence`, async t => {
    const f = await fixture(t, scenario);
    let callbackSummary, callbacks = 0;
    const result = await runAppServerTurn({ ...f.options, ...resumeOptions,
      conversationWorkspace: CONVERSATION_WORKSPACE, policy: { sandbox: 'workspace-write' },
      onThread: async (id, summary) => {
        assert.equal(id, THREAD);
        callbacks += 1;
        const calls = await f.readLog();
        if (callbacks === 1) {
          assert.equal(summary.conversationProject, undefined);
          assert.equal(summary.source, lifecycle === 'resumed' ? 'exec' : 'vscode');
          assert.ok(!calls.some(v => v.method === 'turn/start'));
          assert.ok(!calls.some(v => ['project/list', 'thread/metadata/update', 'thread/name/set'].includes(v.method)));
          if (expectedStart === 'thread/start') assert.ok(!calls.some(v => v.method === 'thread/read'));
          return;
        }
        assert.equal(summary.nativeProjectId, PROJECT);
        assert.equal(summary.conversationProject.projectId, PROJECT);
        assert.equal(summary.conversationProject.originalCwd, f.dir);
        assert.equal(summary.conversationProject.changed, true);
        assert.equal(summary.conversationProject.modelInference, false);
        assert.equal(summary.conversationProject.readBackVerified, true);
        callbackSummary = summary;
        assert.deepEqual(calls.find(v => v.method === 'thread/metadata/update').params,
          { threadId: THREAD, projectId: PROJECT });
        assert.ok(calls.some(v => v.method === 'fixture/turn-persisted'));
        assert.equal(summary.source, lifecycle === 'resumed' ? 'exec' : 'vscode');
        if (resumeOptions.threadId === OLD_THREAD) assert.equal(summary.previousThreadId, OLD_THREAD);
      },
    });
    assert.ok(callbackSummary);
    assert.equal(callbacks, 2);
    assert.equal(result.answer, 'Hello world');
    assert.equal(result.nativeProjectId, PROJECT);
    assert.deepEqual(result.conversationProject, callbackSummary.conversationProject);
    assert.equal(result.desktopWorkspace.originalCwd, f.dir);
    assert.equal(result.desktopWorkspace.verifiedCwd, CONVERSATION_WORKSPACE);
    assert.equal(result.desktopWorkspace.readBackVerified, true);
    const calls = await f.readLog();
    const started = calls.find(v => v.method === expectedStart);
    const projectCalls = calls.filter(v => v.method === 'project/list');
    assert.equal(started.params.cwd, f.dir);
    assert.deepEqual(projectCalls.map(v => ({ limit: v.params.limit, cursor: v.params.cursor ?? null })), [
      { limit: 100, cursor: null }, { limit: 100, cursor: 'exact-root-page' },
    ]);
    assert.ok(calls.indexOf(started) < calls.indexOf(projectCalls[0]));
    const persisted = calls.findIndex(v => v.method === 'fixture/turn-persisted');
    assert.ok(persisted < calls.findIndex(v => v.method === 'project/list'));
    assert.ok(persisted < calls.findIndex(v => v.method === 'thread/metadata/update'));
    assert.ok(persisted < calls.findIndex(v => v.method === 'thread/name/set') || lifecycle === 'resumed');
    assert.equal(calls.filter(v => v.method === 'thread/metadata/update').length, 1);
    assert.ok(!calls.some(v => v.method === 'project/create'));
    const turn = calls.find(v => v.method === 'turn/start').params;
    assert.equal(turn.cwd, f.dir);
    assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [f.dir],
      networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    const transferred = calls.find(v => v.method === 'thread/settings/update');
    assert.deepEqual(transferred.params, { threadId: THREAD, cwd: CONVERSATION_WORKSPACE });
    assert.ok(calls.indexOf(transferred) > calls.findIndex(v => v.method === 'turn/start'));
    assert.ok(!calls.some(v => v.method === 'thread/goal/get'));
  });
}

test('continues an ordinary turn with an explicit skip when no exact project is registered', async t => {
  const f = await fixture(t, 'project-missing');
  let callbackSummary, callbacks = 0;
  const result = await runAppServerTurn({ ...f.options, conversationWorkspace: CONVERSATION_WORKSPACE,
    onThread: async (_id, summary) => {
      callbacks += 1;
      if (callbacks === 1) {
        assert.equal(summary.conversationProject, undefined);
        assert.ok(!(await f.readLog()).some(v => v.method === 'turn/start'));
        return;
      }
      callbackSummary = summary;
      assert.equal(summary.conversationProject.skipped, true);
      assert.ok((await f.readLog()).some(v => v.method === 'fixture/turn-persisted'));
    },
  });
  assert.equal(result.answer, 'Hello world');
  assert.equal(callbacks, 2);
  assert.deepEqual(result.conversationProject, callbackSummary.conversationProject);
  assert.equal(result.nativeProjectId, callbackSummary.nativeProjectId);
  assert.equal(result.desktopWorkspace, undefined);
  const calls = await f.readLog();
  assert.equal(calls.filter(v => v.method === 'project/list').length, 1);
  assert.ok(!calls.some(v => ['thread/metadata/update', 'project/create', 'thread/settings/update'].includes(v.method)));
  assert.equal(calls.find(v => v.method === 'turn/start').params.cwd, f.dir);
});

test('ephemeral turns do not look up or bind a conversation project', async t => {
  const f = await fixture(t, 'project-exists');
  const result = await runAppServerTurn({ ...f.options, ephemeral: true, conversationWorkspace: CONVERSATION_WORKSPACE });
  assert.equal(result.answer, 'Hello world');
  assert.equal(result.desktopWorkspace, undefined);
  const calls = await f.readLog();
  assert.equal(calls.find(v => v.method === 'thread/start').params.ephemeral, true);
  assert.ok(!calls.some(v => ['project/list', 'project/create', 'thread/metadata/update', 'thread/settings/update'].includes(v.method)));
  assert.equal(calls.find(v => v.method === 'turn/start').params.cwd, f.dir);
});

for (const scenario of ['project-sync-failed', 'project-sync-disconnect', 'project-wrong-workspace']) {
  test(`keeps a completed answer and sanitizes optional desktop sync failure for ${scenario}`, async t => {
    const f = await fixture(t, scenario), events = [];
    const result = await runAppServerTurn({ ...f.options, conversationWorkspace: CONVERSATION_WORKSPACE,
      onEvent: e => events.push(e) });
    assert.equal(result.answer, 'Hello world');
    assert.equal(result.desktopWorkspace.readBackVerified, false);
    assert.ok(result.desktopWorkspace.error);
    assert.equal(events.filter(e => e.type === 'turn.completed').length, 1);
    assert.equal(events.filter(e => e.type === 'workspace-sync-failed').length, 1);
    assert.ok(!events.some(e => e.type === 'turn.failed'));
    assert.ok(!JSON.stringify({ result, events }).includes('secret-auth-value'));
    const calls = await f.readLog();
    assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(calls.find(c => c.method === 'turn/start').params.cwd, f.dir);
  });
}

for (const scenario of ['project-failed-turn', 'lazy-failed-turn']) {
  test(`a ${scenario} never looks up or mutates deferred native metadata`, async t => {
    const f = await fixture(t, scenario);
    await assert.rejects(runAppServerTurn({ ...f.options, conversationWorkspace: CONVERSATION_WORKSPACE }), /Inference denied/);
    assert.ok(!(await f.readLog()).some(c => ['project/list', 'thread/metadata/update', 'thread/settings/update', 'thread/name/set'].includes(c.method)));
  });
}

for (const scenario of ['project-sync-hang', 'project-sync-read-hang']) {
  test(`the optional workspace deadline preserves a completed answer when ${scenario} does not reply`, async t => {
    const f = await fixture(t, scenario), events = [];
    const started = Date.now();
    const result = await runAppServerTurn({ ...f.options, timeoutMs: 10000, workspaceSyncTimeoutMs: 150,
      conversationWorkspace: CONVERSATION_WORKSPACE, onEvent: e => events.push(e) });
    assert.equal(result.answer, 'Hello world');
    assert.equal(result.desktopWorkspace.readBackVerified, false);
    assert.ok(Date.now() - started < 3000, 'Optional sync must not wait for the model deadline');
    assert.equal(events.filter(e => e.type === 'workspace-sync-failed').length, 1);
    assert.ok(!events.some(e => e.type === 'turn.failed'));
    assert.equal((await f.readLog()).filter(c => c.method === 'turn/start').length, 1);
  });
}

for (const scenario of ['project-read-failed', 'project-list-failed', 'project-metadata-failed',
  'project-wrong-read-error', 'project-history-failed', 'project-identity-failed']) {
  test(`deferred ${scenario} preserves a completed answer and native history without retrying non-transient errors`, async t => {
    const f = await fixture(t, scenario), events = [], identities = [];
    const result = await runAppServerTurn({ ...f.options, threadId: THREAD, migrateLegacy: false,
      conversationWorkspace: CONVERSATION_WORKSPACE, onEvent: e => events.push(e), onThread: id => identities.push(id) });
    assert.equal(result.answer, 'Hello world');
    assert.equal(result.threadId, THREAD);
    assert.equal(result.conversationProject.readBackVerified, false);
    assert.equal(result.desktopWorkspace.readBackVerified, false);
    assert.deepEqual(identities, [THREAD]);
    assert.ok(!JSON.stringify({ result, events }).includes('secret-auth-value'));
    assert.equal(events.filter(e => e.type === 'workspace-sync-failed').length, 1);
    assert.ok(!events.some(e => e.type === 'turn.failed'));
    const calls = await f.readLog();
    assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(calls.filter(c => c.method === 'thread/read').length, 1);
    assert.ok(!calls.some(c => ['thread/start', 'thread/fork', 'thread/settings/update'].includes(c.method)));
    assert.deepEqual(JSON.parse(await fs.readFile(f.historyFile, 'utf8')), [
      { role: 'user', text: 'Existing native history' }, { role: 'assistant', text: 'Existing native answer' },
      { role: 'user', text: 'Actual user request' }, { role: 'assistant', text: 'Hello world' },
    ]);
  });
}

for (const scenario of ['project-read-hang', 'project-list-hang', 'project-metadata-hang', 'lazy-rollout-never']) {
  test(`the entire deferred association deadline preserves the answer during ${scenario}`, async t => {
    const f = await fixture(t, scenario), started = Date.now();
    const result = await runAppServerTurn({ ...f.options, timeoutMs: 10000, workspaceSyncTimeoutMs: 150,
      conversationWorkspace: CONVERSATION_WORKSPACE });
    assert.equal(result.answer, 'Hello world');
    assert.equal(result.desktopWorkspace.readBackVerified, false);
    assert.ok(Date.now() - started < 3000);
    const calls = await f.readLog();
    assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
    assert.ok(!calls.some(c => c.method === 'thread/settings/update'));
    if (scenario === 'lazy-rollout-never') {
      assert.ok(calls.filter(c => c.method === 'thread/read').length >= 2);
      assert.ok(!calls.some(c => ['project/list', 'thread/metadata/update'].includes(c.method)));
    }
  });
}

test('optional enriched mapping callback failure preserves the first native identity and completed answer', async t => {
  const f = await fixture(t, 'project-exists'), events = [];
  let callbacks = 0;
  const result = await runAppServerTurn({ ...f.options, conversationWorkspace: CONVERSATION_WORKSPACE,
    onEvent: e => events.push(e), onThread: async (id, summary) => {
      assert.equal(id, THREAD);
      assert.equal(summary.source, 'vscode');
      callbacks += 1;
      if (callbacks === 1) assert.ok(!(await f.readLog()).some(c => c.method === 'turn/start'));
      else throw new Error('Mapping persistence failed: secret-auth-value.');
    } });
  assert.equal(callbacks, 2);
  assert.equal(result.answer, 'Hello world');
  assert.equal(result.nativeProjectId, PROJECT);
  assert.equal(result.desktopWorkspace.readBackVerified, false);
  assert.ok(!JSON.stringify({ result, events }).includes('secret-auth-value'));
  assert.equal(events.filter(e => e.type === 'workspace-sync-failed').length, 1);
});

test('optional title metadata failure does not undo a completed turn or verified project synchronization', async t => {
  const f = await fixture(t, 'project-name-failed'), events = [];
  const result = await runAppServerTurn({ ...f.options, conversationWorkspace: CONVERSATION_WORKSPACE,
    onEvent: e => events.push(e) });
  assert.equal(result.answer, 'Hello world');
  assert.equal(result.desktopWorkspace.readBackVerified, true);
  assert.equal(events.filter(e => e.type === 'thread-name-sync-failed').length, 1);
  assert.ok(!JSON.stringify({ result, events }).includes('secret-auth-value'));
});

test('a failed resumed native turn leaves existing history intact and sends no optional metadata', async t => {
  const f = await fixture(t, 'project-failed-turn');
  await assert.rejects(runAppServerTurn({ ...f.options, threadId: THREAD, migrateLegacy: false,
    conversationWorkspace: CONVERSATION_WORKSPACE }), /Inference denied/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.historyFile, 'utf8')), [
    { role: 'user', text: 'Existing native history' }, { role: 'assistant', text: 'Existing native answer' },
  ]);
  assert.ok(!(await f.readLog()).some(c => ['project/list', 'thread/metadata/update', 'thread/settings/update', 'thread/name/set'].includes(c.method)));
});
