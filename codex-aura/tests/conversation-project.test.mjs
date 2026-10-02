import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { linkConversationProject, createProjectRpc } from '../scripts/link-conversation-project.mjs';
import { setConversationDesktopWorkspace } from '../lib/app-server.mjs';

const THREAD = '11111111-1111-7111-8111-111111111111';
const OTHER_THREAD = '22222222-2222-7222-8222-222222222222';
const PROJECT = '33333333-3333-7333-8333-333333333333';
const OLD_PROJECT = '44444444-4444-7444-8444-444444444444';
const WORKSPACE = 'D:\\Workspaces\\Aura';
const ORIGINAL_CWD = 'D:\\UEProjects\\ActualGame';

function project(id = PROJECT, root = WORKSPACE, name = 'Aura') {
  return { id, name, roots: [{ path: root }] };
}

// All state stays in memory. Unexpected RPCs fail so these tests cannot silently
// start inference, create a project/thread, or write application configuration.
function fixture({ initial = {}, pages = [{ data: [project()], nextCursor: null }],
  firstReadError, updateResult, readback = {}, settingsReadLag = 0, settingsReadback = {},
  settingsError, resumeError, resumeResult = {}, goalResult = { goal: null } } = {}) {
  const calls = [];
  const original = { id: THREAD, cwd: ORIGINAL_CWD, projectId: OLD_PROJECT, status: { type: 'notLoaded' }, ...initial };
  let current = { ...original };
  let reads = 0;
  let pageIndex = 0;
  let pendingWorkspace, remainingSettingsReads = settingsReadLag;
  const rpc = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'thread/read') {
      assert.deepEqual(params, { threadId: THREAD, includeTurns: false });
      reads += 1;
      if (reads === 1 && firstReadError) throw firstReadError;
      if (pendingWorkspace && remainingSettingsReads-- <= 0) current.cwd = pendingWorkspace;
      return { thread: { ...(reads === 1 ? original : current), ...(reads === 1 ? {} : readback),
        ...(pendingWorkspace ? settingsReadback : {}) } };
    }
    if (method === 'project/list') {
      assert.equal(params.limit, 100);
      const expectedCursor = pageIndex === 0 ? null : pages[pageIndex - 1].nextCursor;
      assert.equal(params.cursor ?? null, expectedCursor);
      assert.ok(pageIndex < pages.length, 'Requested an unexpected extra project page');
      return structuredClone(pages[pageIndex++]);
    }
    if (method === 'thread/metadata/update') {
      assert.deepEqual(params, { threadId: THREAD, projectId: PROJECT });
      current = { ...current, projectId: params.projectId };
      return { thread: { ...current, ...updateResult } };
    }
    if (method === 'thread/goal/get') {
      assert.deepEqual(params, { threadId: THREAD });
      return goalResult;
    }
    if (method === 'thread/resume') {
      assert.deepEqual(params, { threadId: THREAD, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
      if (resumeError) throw resumeError;
      current.status = { type: 'idle' };
      return { thread: { ...current }, cwd: current.cwd, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, ...resumeResult };
    }
    if (method === 'thread/settings/update') {
      assert.deepEqual(params, { threadId: THREAD, cwd: WORKSPACE });
      if (settingsError) throw settingsError;
      pendingWorkspace = params.cwd;
      return {};
    }
    assert.fail(`Unexpected RPC: ${method}`);
  };
  return { calls, rpc, options: { threadId: THREAD, workspace: WORKSPACE } };
}

function mutations(f) {
  return f.calls.filter(call => call.method === 'thread/metadata/update');
}

test('associates the exact registered root across pages and preserves the actual UE cwd', async () => {
  const f = fixture({ pages: [
    { data: [project('sibling', `${WORKSPACE}-old`)], nextCursor: 'page-2' },
    { data: [project('descendant', `${WORKSPACE}\\Subproject`), project()], nextCursor: 'page-3' },
    { data: [project('unrelated', 'E:\\Other')], nextCursor: null },
  ] });
  const result = await linkConversationProject(f.options, { rpc: f.rpc });
  assert.equal(result.threadId, THREAD);
  assert.equal(result.projectId, PROJECT);
  assert.equal(result.projectName, 'Aura');
  assert.equal(result.originalCwd, ORIGINAL_CWD);
  assert.equal(result.previousProjectId, OLD_PROJECT);
  assert.equal(result.changed, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.modelInference, false);
  assert.deepEqual(f.calls.map(call => call.method), [
    'thread/read', 'project/list', 'project/list', 'project/list',
    'thread/metadata/update', 'thread/read',
  ]);
});

for (const [description, root] of [
  ['similarly named sibling', `${WORKSPACE}-copy`],
  ['descendant', `${WORKSPACE}\\Content`],
  ['ancestor', 'D:\\Workspaces'],
]) {
  test(`refuses a ${description} as an exact project root`, async () => {
    const f = fixture({ pages: [{ data: [project(PROJECT, root)], nextCursor: null }] });
    await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
    assert.equal(mutations(f).length, 0);
  });
}

test('surfaces an unknown thread without project lookup or mutation', async () => {
  const f = fixture({ firstReadError: new Error('Thread not found') });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }), /Thread not found/);
  assert.deepEqual(f.calls.map(call => call.method), ['thread/read']);
});

test('refuses a read response identifying a different thread', async () => {
  const f = fixture({ initial: { id: OTHER_THREAD } });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.deepEqual(f.calls.map(call => call.method), ['thread/read']);
});

for (const [description, cwd] of [
  ['missing', undefined], ['empty', ''], ['relative', 'UEProjects\\ActualGame'],
  ['drive-relative', 'D:ActualGame'],
]) {
  test(`refuses a ${description} original cwd before mutation`, async () => {
    const f = fixture({ initial: { cwd } });
    await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
    assert.equal(mutations(f).length, 0);
  });
}

test('refuses readback when cwd changes to the Codex workspace', async () => {
  const f = fixture({ readback: { cwd: WORKSPACE } });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(mutations(f).length, 1);
  assert.equal(f.calls.at(-1).method, 'thread/read');
});

test('requires the exact original cwd string in readback, even for an equivalent path', async () => {
  const f = fixture({ readback: { cwd: ORIGINAL_CWD.replaceAll('\\', '/') } });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(mutations(f).length, 1);
});

test('refuses readback when the project association did not persist', async () => {
  const f = fixture({ readback: { projectId: OLD_PROJECT } });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(mutations(f).length, 1);
  assert.equal(f.calls.at(-1).method, 'thread/read');
});

test('refuses readback identifying a different thread', async () => {
  const f = fixture({ readback: { id: OTHER_THREAD } });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(mutations(f).length, 1);
});

for (const [description, updateResult] of [
  ['thread identity', { id: OTHER_THREAD }],
  ['project association', { projectId: OLD_PROJECT }],
  ['original cwd', { cwd: WORKSPACE }],
]) {
  test(`refuses an update response with changed ${description}`, async () => {
    const f = fixture({ updateResult });
    await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
    assert.equal(mutations(f).length, 1);
  });
}

test('refuses when no project is registered for the requested workspace', async () => {
  const f = fixture({ pages: [{ data: [], nextCursor: null }] });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(mutations(f).length, 0);
});

test('dry run returns the planned existing association without any write', async () => {
  const f = fixture();
  const result = await linkConversationProject({ ...f.options, dryRun: true }, { rpc: f.rpc });
  const expected = {
    threadId: THREAD, projectId: PROJECT, projectName: 'Aura', workspace: WORKSPACE,
    originalCwd: ORIGINAL_CWD, previousProjectId: OLD_PROJECT,
    dryRun: true, changed: false, modelInference: false,
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, key);
  assert.equal(mutations(f).length, 0);
  assert.ok(f.calls.every(call => ['thread/read', 'project/list'].includes(call.method)));
});

test('an already assigned project skips mutation and still verifies readback', async () => {
  const f = fixture({ initial: { projectId: PROJECT } });
  const result = await linkConversationProject(f.options, { rpc: f.rpc });
  assert.equal(result.changed, false);
  assert.equal(result.previousProjectId, PROJECT);
  assert.equal(mutations(f).length, 0);
  assert.deepEqual(f.calls.map(call => call.method), ['thread/read', 'project/list', 'thread/read']);
});

test('an already assigned project still refuses a changed readback cwd', async () => {
  const f = fixture({ initial: { projectId: PROJECT }, readback: { cwd: WORKSPACE } });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(mutations(f).length, 0);
  assert.equal(f.calls.filter(call => call.method === 'thread/read').length, 2);
});

test('refuses distinct registered projects with the same normalized root', async () => {
  const f = fixture({ pages: [{ data: [project(), project(OLD_PROJECT, WORKSPACE.toLowerCase())], nextCursor: null }] });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(mutations(f).length, 0);
});

test('continues paging after a match and refuses a duplicate root on a later page', async () => {
  const f = fixture({ pages: [
    { data: [project()], nextCursor: 'next-page' },
    { data: [project(OLD_PROJECT)], nextCursor: null },
  ] });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(f.calls.filter(call => call.method === 'project/list').length, 2);
  assert.equal(mutations(f).length, 0);
});

test('refuses a repeated pagination cursor before any write', async () => {
  const f = fixture({ pages: [
    { data: [project()], nextCursor: 'repeated' },
    { data: [], nextCursor: 'repeated' },
  ] });
  await assert.rejects(linkConversationProject(f.options, { rpc: f.rpc }));
  assert.equal(f.calls.filter(call => call.method === 'project/list').length, 2);
  assert.equal(mutations(f).length, 0);
});

for (const [description, root] of [
  ['case-insensitive', WORKSPACE.toLowerCase()],
  ['forward slashes', WORKSPACE.replaceAll('\\', '/')],
  ['trailing separators', `${WORKSPACE}\\\\`],
  ['case, slashes, and trailing separator together', `${WORKSPACE.toLowerCase().replaceAll('\\', '/')}/`],
]) {
  test(`matches Windows roots with ${description}`, async () => {
    const f = fixture({ pages: [{ data: [project(PROJECT, root)], nextCursor: null }] });
    const result = await linkConversationProject(f.options, { rpc: f.rpc });
    assert.equal(result.projectId, PROJECT);
    assert.equal(result.originalCwd, ORIGINAL_CWD);
    assert.equal(mutations(f).length, 1);
  });
}

test('finds an exact root among multiple roots of one registered project', async () => {
  const p = project();
  p.roots.unshift({ path: 'E:\\Other' });
  const f = fixture({ pages: [{ data: [p], nextCursor: null }] });
  const result = await linkConversationProject(f.options, { rpc: f.rpc });
  assert.equal(result.projectId, PROJECT);
});

test('counts repeated equivalent roots in the same project as one association', async () => {
  const p = project();
  p.roots.push({ path: `${WORKSPACE.toLowerCase()}\\` });
  const f = fixture({ pages: [{ data: [p], nextCursor: null }] });
  const result = await linkConversationProject(f.options, { rpc: f.rpc });
  assert.equal(result.projectId, PROJECT);
  assert.equal(mutations(f).length, 1);
});

test('explicit desktop compatibility uses only a read-only resume and preserves the original UE cwd in its result', async () => {
  const f = fixture();
  const result = await linkConversationProject({ ...f.options, desktopWorkspace: true }, { rpc: f.rpc });
  assert.equal(result.originalCwd, ORIGINAL_CWD);
  assert.equal(result.desktopWorkspace.originalCwd, ORIGINAL_CWD);
  assert.equal(result.desktopWorkspace.verifiedCwd, WORKSPACE);
  assert.equal(result.desktopWorkspace.readBackVerified, true);
  assert.equal(result.desktopWorkspace.modelInference, false);
  assert.equal(result.desktopWorkspace.changed, true);
  assert.deepEqual(f.calls.find(c => c.method === 'thread/resume').params,
    { threadId: THREAD, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
  assert.ok(!f.calls.some(c => ['turn/start', 'thread/start', 'thread/fork'].includes(c.method)));
  assert.deepEqual(f.calls.find(c => c.method === 'thread/settings/update').params, { threadId: THREAD, cwd: WORKSPACE });
});

test('desktop verification waits for queued settings instead of accepting the empty RPC acknowledgment', async () => {
  const f = fixture({ settingsReadLag: 2 });
  const delays = [];
  const result = await linkConversationProject({ ...f.options, desktopWorkspace: true },
    { rpc: f.rpc, wait: async ms => { delays.push(ms); }, readBackDelayMs: 25 });
  assert.equal(result.desktopWorkspace.verifiedCwd, WORKSPACE);
  assert.deepEqual(delays, [25, 25]);
  assert.equal(f.calls.filter(c => c.method === 'thread/settings/update').length, 1);
});

test('desktop dry run does not load, continue a goal, or update default settings', async () => {
  const f = fixture();
  const result = await linkConversationProject({ ...f.options, desktopWorkspace: true, dryRun: true }, { rpc: f.rpc });
  assert.equal(result.desktopWorkspace.readBackVerified, false);
  assert.equal(result.desktopWorkspace.workspace, WORKSPACE);
  assert.ok(f.calls.every(c => ['thread/read', 'project/list'].includes(c.method)));
});

for (const [label, initial] of [
  ['active', { status: { type: 'active', activeFlags: [] } }],
  ['unknown runtime status', { status: undefined }],
  ['ephemeral', { ephemeral: true }],
]) {
  test(`desktop compatibility refuses ${label} conversations before any write`, async () => {
    const f = fixture({ initial });
    await assert.rejects(linkConversationProject({ ...f.options, desktopWorkspace: true }, { rpc: f.rpc }));
    assert.deepEqual(f.calls.map(c => c.method), ['thread/read']);
  });
}

for (const [label, goalResult] of [
  ['active goal', { goal: { threadId: THREAD, status: 'active' } }],
  ['unavailable goal state', {}],
  ['goal from another thread', { goal: { threadId: OTHER_THREAD, status: 'complete' } }],
]) {
  test(`desktop compatibility refuses cold resume for ${label}`, async () => {
    const f = fixture({ goalResult });
    await assert.rejects(linkConversationProject({ ...f.options, desktopWorkspace: true }, { rpc: f.rpc }), /goal/);
    assert.ok(!f.calls.some(c => ['thread/resume', 'thread/settings/update'].includes(c.method)));
  });
}

test('a native writer refusal stops workspace preparation without a takeover, fork, or retry', async () => {
  const f = fixture({ resumeError: new Error('Existing writer holds this conversation') });
  await assert.rejects(linkConversationProject({ ...f.options, desktopWorkspace: true }, { rpc: f.rpc }), /Existing writer/);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
  assert.ok(!f.calls.some(c => ['thread/settings/update', 'thread/fork', 'turn/start'].includes(c.method)));
});

for (const [label, resumeResult] of [
  ['unexpected configured cwd', { cwd: 'E:\\Unexpected' }],
  ['interactive approval policy', { approvalPolicy: 'on-request' }],
  ['writable sandbox', { sandbox: { type: 'workspaceWrite', writableRoots: [ORIGINAL_CWD] } }],
]) {
  test(`refuses ${label} returned by a resumed thread`, async () => {
    const f = fixture({ resumeResult });
    await assert.rejects(linkConversationProject({ ...f.options, desktopWorkspace: true }, { rpc: f.rpc }), /read-only/);
    assert.ok(!f.calls.some(c => c.method === 'thread/settings/update'));
  });
}

for (const [label, settingsReadback] of [
  ['a different thread', { id: OTHER_THREAD }],
  ['a different project', { projectId: OLD_PROJECT }],
  ['an unexpected third directory', { cwd: 'E:\\Unexpected' }],
  ['an active turn', { status: { type: 'active', activeFlags: [] } }],
]) {
  test(`never verifies desktop read-back for ${label}`, async () => {
    const f = fixture({ settingsReadback });
    await assert.rejects(linkConversationProject({ ...f.options, desktopWorkspace: true }, { rpc: f.rpc }));
    assert.equal(f.calls.filter(c => c.method === 'thread/settings/update').length, 1);
  });
}

test('queued desktop settings time out as unverified with no retrying mutation', async () => {
  const f = fixture({ settingsReadLag: 100 });
  let waits = 0;
  await assert.rejects(linkConversationProject({ ...f.options, desktopWorkspace: true },
    { rpc: f.rpc, readBackAttempts: 3, wait: async () => { waits += 1; } }), /unverified.*may still apply/);
  assert.equal(waits, 2);
  assert.equal(f.calls.filter(c => c.method === 'thread/settings/update').length, 1);
});

test('an already matching default workspace requires neither resume nor a settings mutation', async () => {
  const f = fixture({ initial: { cwd: WORKSPACE, projectId: PROJECT } });
  const result = await linkConversationProject({ ...f.options, desktopWorkspace: true }, { rpc: f.rpc });
  assert.equal(result.desktopWorkspace.changed, false);
  assert.equal(result.desktopWorkspace.readBackVerified, true);
  assert.ok(!f.calls.some(c => ['thread/resume', 'thread/goal/get', 'thread/settings/update'].includes(c.method)));
});

test('the owned-turn workspace helper will not load a missing native writer', async () => {
  const f = fixture({ initial: { projectId: PROJECT } });
  await assert.rejects(setConversationDesktopWorkspace({ ...f.options, projectId: PROJECT }, { rpc: f.rpc }), /not loaded/);
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read']);
});

test('project RPC transport rejects inference, model overrides, history injection, and writable resumes', async t => {
  const fake = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
  const client = createProjectRpc({ cli: { command: process.execPath, prefixArgs: [fake] } });
  t.after(() => client.close());
  await assert.rejects(client.rpc('turn/start', { threadId: THREAD, input: [] }), /only allows/);
  await assert.rejects(client.rpc('thread/fork', { threadId: THREAD }), /only allows/);
  for (const unsafe of [
    { sandbox: 'workspace-write' }, { approvalPolicy: 'on-request' },
    { history: [] }, { path: 'D:\\a-rollout.jsonl' }, { model: 'another-model' },
  ]) {
    await assert.rejects(client.rpc('thread/resume', { threadId: THREAD, excludeTurns: true,
      approvalPolicy: 'never', sandbox: 'read-only', ...unsafe }), /read-only/);
  }
  await assert.rejects(client.rpc('thread/settings/update', { threadId: THREAD, cwd: WORKSPACE, model: 'another-model' }), /only.*working directory/);
});

test('workspace verification has an overall deadline even when a public read never replies', async () => {
  const calls = [];
  const started = Date.now();
  await assert.rejects(setConversationDesktopWorkspace({ threadId: THREAD, workspace: WORKSPACE, projectId: PROJECT },
    { rpc: async method => { calls.push(method); return new Promise(() => {}); }, verificationTimeoutMs: 25 }), /verification timed out/);
  assert.deepEqual(calls, ['thread/read']);
  assert.ok(Date.now() - started < 1000);
});
