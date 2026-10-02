import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const scenario = process.env.FAKE_APP_SCENARIO || 'success';
const THREAD = '11111111-1111-7111-8111-111111111111';
const OLD_THREAD = '33333333-3333-7333-8333-333333333333';
const PROJECT = '44444444-4444-7444-8444-444444444444';
const TURN = '22222222-2222-7222-8222-222222222222';
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const notify = (method, params) => emit({ method, params: { threadId: THREAD, turnId: TURN, ...params } });
const reply = (id, result) => emit({ id, result });
const log = obj => { if (process.env.FAKE_APP_LOG) appendFileSync(process.env.FAKE_APP_LOG, JSON.stringify(obj) + '\n'); };
let timer, grandchild, workspaceTimer;
let threadCwd = process.env.FAKE_APP_CWD || process.cwd(), threadSource = 'vscode', projectId = null;
let threadLoaded = false, threadActive = false, ephemeral = false, settingsQueued = false, turnPersisted = false;
let rolloutAvailable = true, remainingRolloutReads = 0, latestInput;
const lazyRollout = ['lazy-rollout', 'lazy-rollout-lag', 'lazy-fork', 'lazy-failed-turn', 'lazy-rollout-never'].includes(scenario);
const projectExists = ['project-exists', 'project-sync-failed', 'project-sync-disconnect', 'project-sync-hang',
  'project-sync-read-hang', 'project-wrong-workspace', 'project-failed-turn', 'project-read-failed', 'project-list-failed',
  'project-metadata-failed', 'project-metadata-hang', 'project-read-hang', 'project-list-hang', 'project-name-failed',
  'project-wrong-read-error', 'project-history-failed', 'project-identity-failed'].includes(scenario) || lazyRollout;
let nativeHistory = [{ role: 'user', text: 'Existing native history' }, { role: 'assistant', text: 'Existing native answer' }];
const thread = id => ({ id, cwd: threadCwd, projectId, source: id === OLD_THREAD ? 'exec' : threadSource,
  ephemeral, status: { type: threadActive ? 'active' : threadLoaded ? 'idle' : 'notLoaded', ...(threadActive ? { activeFlags: [] } : {}) } });
const finish = () => {
  threadActive = false;
  const item = { id: 'answer', type: 'agentMessage', text: 'Hello world', phase: 'final_answer' };
  notify('item/completed', { item });
  const failed = ['failed', 'project-failed-turn'].includes(scenario);
  const isFailed = failed || scenario === 'lazy-failed-turn';
  turnPersisted = true;
  remainingRolloutReads = scenario === 'lazy-rollout-lag' ? 2 : scenario === 'lazy-rollout-never' ? 1000 : 0;
  rolloutAvailable = remainingRolloutReads === 0;
  if (!isFailed) nativeHistory.push({ role: 'user', text: latestInput }, { role: 'assistant', text: item.text });
  if (process.env.FAKE_APP_HISTORY_FILE) writeFileSync(process.env.FAKE_APP_HISTORY_FILE, JSON.stringify(nativeHistory));
  log({ method: 'fixture/turn-persisted', params: { threadId: THREAD, status: isFailed ? 'failed' : 'completed' } });
  notify('turn/completed', { turn: { id: TURN, status: isFailed ? 'failed' : 'completed',
    error: isFailed ? { message: 'Inference denied by fixture.' } : null, items: [item] } });
};
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const m = JSON.parse(line); log(m);
  if (!m.method) {
    if (m.id === 'approval1') finish();
    return;
  }
  switch (m.method) {
    case 'initialize': reply(m.id, { userAgent: 'fake' }); break;
    case 'initialized': break;
    case 'thread/read':
      if (m.params.threadId === THREAD && !rolloutAvailable) {
        if (turnPersisted && --remainingRolloutReads <= 0) rolloutAvailable = true;
        emit({ id: m.id, error: { code: -32602, message: `failed to read thread metadata: invalid thread-store request: no rollout found for thread id ${THREAD}` } });
        break;
      }
      if (turnPersisted && scenario === 'project-read-hang') break;
      if (turnPersisted && scenario === 'project-identity-failed') { reply(m.id, { thread: thread('99999999-9999-7999-8999-999999999999') }); break; }
      if (turnPersisted && ['project-read-failed', 'project-wrong-read-error', 'project-history-failed'].includes(scenario)) {
        emit({ id: m.id, error: { code: -32602, message: scenario === 'project-wrong-read-error'
          ? 'no rollout found for thread id 99999999-9999-7999-8999-999999999999'
          : scenario === 'project-history-failed' ? 'Corrupt native history: secret-auth-value.' : 'Permission failure: secret-auth-value.' } }); break;
      }
      if (settingsQueued && scenario === 'project-sync-read-hang') break;
      reply(m.id, { thread: thread(m.params.threadId) }); break;
    case 'thread/fork':
      threadLoaded = true;
      rolloutAvailable = !lazyRollout;
      threadCwd = m.params.cwd || threadCwd;
      threadSource = scenario === 'hidden-fork' ? 'exec' : 'vscode';
      reply(m.id, { thread: { ...thread(THREAD), forkedFromId: m.params.threadId } }); break;
    case 'thread/start':
    case 'thread/resume':
      threadLoaded = true;
      ephemeral = m.params.ephemeral ?? ephemeral;
      threadCwd = m.params.cwd || threadCwd;
      threadSource = m.method === 'thread/resume' ? 'exec' : 'vscode';
      if (m.method === 'thread/start') { rolloutAvailable = !lazyRollout; nativeHistory = []; }
      reply(m.id, { thread: thread(scenario === 'wrong-resume' ? '99999999-9999-7999-8999-999999999999' : m.params.threadId || THREAD),
        approvalPolicy: m.params.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false } }); break;
    case 'project/list':
      if (scenario === 'project-list-hang') break;
      if (scenario === 'project-list-failed') { emit({ id: m.id, error: { code: -32602, message: 'Project catalog failure: secret-auth-value.' } }); break; }
      reply(m.id, projectExists && m.params.cursor === 'exact-root-page'
        ? { data: [{ id: PROJECT, name: 'Aura conversation project', roots: [{ path: 'D:\\Codex\\Test' }] }], nextCursor: null }
        : { data: [{ id: '55555555-5555-7555-8555-555555555555', name: 'Similar sibling', roots: [{ path: 'D:\\Codex\\Test 5.8' }] }],
          nextCursor: projectExists ? 'exact-root-page' : null });
      break;
    case 'thread/metadata/update':
      if (scenario === 'project-metadata-hang') break;
      if (!rolloutAvailable || scenario === 'project-metadata-failed') { emit({ id: m.id, error: { code: -32602, message: 'Metadata unavailable: secret-auth-value.' } }); break; }
      projectId = m.params.projectId;
      reply(m.id, { thread: thread(m.params.threadId) });
      break;
    case 'thread/settings/update':
      settingsQueued = true;
      if (scenario === 'project-sync-hang') break;
      if (scenario === 'project-sync-disconnect') { process.exit(7); break; }
      if (threadActive || !threadLoaded || scenario === 'project-sync-failed') {
        emit({ id: m.id, error: { code: -32602, message: 'Fixture workspace update refused: secret-auth-value.' } });
        break;
      }
      reply(m.id, {});
      // The real public API acknowledges the queued update before applying it.
      workspaceTimer = setTimeout(() => { threadCwd = scenario === 'project-wrong-workspace' ? 'D:\\Unexpected' : m.params.cwd; }, 20);
      break;
    case 'thread/name/set':
      if (!rolloutAvailable || scenario === 'project-name-failed') { emit({ id: m.id, error: { code: -32602, message: 'Title unavailable: secret-auth-value.' } }); break; }
      reply(m.id, {}); break;
    case 'turn/start': {
      threadCwd = m.params.cwd;
      latestInput = m.params.input[0].text;
      threadActive = true;
      reply(m.id, { turn: { id: TURN, status: 'inProgress', items: [] } });
      notify('turn/started', { turn: { id: TURN, status: 'inProgress', items: [] } });
      if (scenario === 'disconnect') { process.exit(7); break; }
      if (scenario === 'invalid') { process.stdout.write('{bad\n'); break; }
      if (scenario === 'cancel' || scenario === 'timeout') {
        grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore' });
        if (process.env.FAKE_APP_CHILD_PID) writeFileSync(process.env.FAKE_APP_CHILD_PID, String(grandchild.pid));
        timer = setInterval(() => {}, 10_000); break;
      }
      notify('item/started', { item: { id: 'answer', type: 'agentMessage', text: '' } });
      notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello ' });
      notify('item/agentMessage/delta', { itemId: 'answer', delta: 'world' });
      notify('item/completed', { item: { id: 'tool', type: 'mcpToolCall', server: 'ue', tool: 'get_asset_meta', arguments: {}, status: 'completed' } });
      if (scenario === 'approval') emit({ id: 'approval1', method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: TURN } });
      else finish();
      break;
    }
    case 'turn/interrupt': reply(m.id, {}); break;
    default: emit({ id: m.id, error: { code: -32601, message: 'Unexpected method' } });
  }
});
input.on('close', () => { clearInterval(timer); clearTimeout(workspaceTimer); grandchild?.kill(); process.exit(0); });
