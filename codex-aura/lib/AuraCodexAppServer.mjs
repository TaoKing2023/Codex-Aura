import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE = 8 * 1024 * 1024;

async function killOwnedTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, maxBuffer: 64_000 });
    } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
  }
}

function declinedRequest(method) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: { denied: { rejection: 'Aura does not grant interactive approvals.' } } };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/tool/call') return { success: false, contentItems: [{ type: 'inputText', text: 'Aura does not implement client-side dynamic tools.' }] };
  return undefined;
}

export function normalizeConversationWorkspace(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('An absolute workspace path is required.');
  const windows = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(value)) throw new Error('An absolute workspace path is required.');
  let normalized = api.normalize(value);
  if (windows) {
    if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = '\\\\' + normalized.slice(8);
    else if (/^\\\\\?\\[A-Za-z]:\\/.test(normalized)) normalized = normalized.slice(4);
  }
  const root = api.parse(normalized).root;
  while (normalized.length > root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return { display: normalized, key: windows ? normalized.toLowerCase() : normalized };
}

function checkedThread(response, threadId, originalCwd) {
  const thread = response?.thread;
  if (!thread || typeof thread.id !== 'string' || thread.id.toLowerCase() !== threadId) {
    throw new Error('Codex returned a different or unknown conversation; no further update was sent.');
  }
  normalizeConversationWorkspace(thread.cwd);
  if (originalCwd !== undefined && thread.cwd !== originalCwd) {
    throw new Error('The conversation working directory changed during verification. The project association is not verified.');
  }
  return thread;
}

/** `rpc` is injectable so validation can be tested without native state writes. */
export async function linkConversationProject({ threadId, workspace, dryRun = false, desktopWorkspace = false } = {},
  { rpc, missingProject = 'error', ...verification } = {}) {
  if (typeof threadId !== 'string' || !UUID.test(threadId)) throw new Error('A valid existing Codex conversation UUID is required.');
  if (typeof rpc !== 'function') throw new Error('A public app-server RPC client is required.');
  threadId = threadId.toLowerCase();
  const target = normalizeConversationWorkspace(workspace);
  const before = checkedThread(await rpc('thread/read', { threadId, includeTurns: false }), threadId);
  if (desktopWorkspace) checkedWorkspaceTransferThread(before);
  const originalCwd = before.cwd;
  const matches = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 1000; page += 1) {
    const result = await rpc('project/list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    if (!Array.isArray(result?.data)) throw new Error('Codex returned an invalid project catalog.');
    for (const project of result.data) {
      if (typeof project?.id !== 'string' || !project.id || !Array.isArray(project.roots)) throw new Error('Codex returned an invalid project record.');
      if (project.roots.some(root => normalizeConversationWorkspace(root?.path).key === target.key)) matches.set(project.id, project);
    }
    if (result.nextCursor == null) break;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error('Codex returned a repeated or invalid project catalog cursor.');
    cursors.add(result.nextCursor); cursor = result.nextCursor;
    if (page === 999) throw new Error('Codex project catalog pagination exceeded its limit.');
  }
  if (matches.size === 0) {
    if (missingProject === 'skip') return { threadId, workspace: target.display, originalCwd, previousProjectId: before.projectId ?? null,
      dryRun: Boolean(dryRun), changed: false, skipped: true, reason: 'project-not-registered', modelInference: false };
    throw new Error('No registered Codex project has this exact workspace root. Add the folder as a local Project in Codex first.');
  }
  if (matches.size !== 1) throw new Error('Multiple registered Codex projects have this exact workspace root; no update was sent.');
  const project = matches.values().next().value;
  const previousProjectId = before.projectId ?? null;
  const result = {
    threadId, projectId: project.id, projectName: project.name ?? '', workspace: target.display,
    originalCwd, previousProjectId, dryRun: Boolean(dryRun), changed: false, modelInference: false,
  };
  if (dryRun) return { ...result, readBackVerified: false, ...(desktopWorkspace ? { desktopWorkspace: {
    threadId, workspace: target.display, originalCwd, dryRun: true, changed: false,
    readBackVerified: false, modelInference: false,
  } } : {}) };
  if (previousProjectId !== project.id) {
    const updated = checkedThread(await rpc('thread/metadata/update', { threadId, projectId: project.id }), threadId, originalCwd);
    if (updated.projectId !== project.id) throw new Error('Codex did not confirm the requested project association.');
    result.changed = true;
  }
  const after = checkedThread(await rpc('thread/read', { threadId, includeTurns: false }), threadId, originalCwd);
  if (after.projectId !== project.id) throw new Error('The project association did not persist; read-back verification failed.');
  const transfer = desktopWorkspace ? await setConversationDesktopWorkspace({
    threadId, workspace: target.display, projectId: project.id, loadIfNeeded: true,
  }, { rpc, ...verification }) : undefined;
  return { ...result, verifiedCwd: after.cwd, readBackVerified: true,
    ...(transfer ? { desktopWorkspace: transfer } : {}) };
}

function checkedWorkspaceTransferThread(thread) {
  if (thread.ephemeral) throw new Error('An ephemeral conversation cannot receive a persistent desktop workspace.');
  if (!['notLoaded', 'idle'].includes(thread.status?.type)) {
    throw new Error('The conversation is active or its runtime status is unavailable; no desktop workspace update was sent.');
  }
}

/** Change only the default workspace after work is idle. Per-turn cwd and
 * sandbox roots remain explicit at the next Aura turn/start invocation. */
export async function setConversationDesktopWorkspace({ threadId, workspace, projectId, loadIfNeeded = false } = {},
  { rpc, readBackAttempts = 25, readBackDelayMs = 100,
    verificationTimeoutMs = 5000,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof threadId !== 'string' || !UUID.test(threadId)) throw new Error('A valid existing Codex conversation UUID is required.');
  if (typeof rpc !== 'function') throw new Error('A public app-server RPC client is required.');
  if (typeof projectId !== 'string' || !projectId) throw new Error('A verified existing project association is required.');
  if (!Number.isInteger(readBackAttempts) || readBackAttempts < 1 || readBackAttempts > 100 ||
    !Number.isFinite(readBackDelayMs) || readBackDelayMs < 0 ||
    !Number.isFinite(verificationTimeoutMs) || verificationTimeoutMs <= 0 || typeof wait !== 'function') throw new Error('Invalid desktop workspace verification bounds.');
  threadId = threadId.toLowerCase();
  const deadline = Date.now() + verificationTimeoutMs;
  const bounded = async action => {
    const remaining = deadline - Date.now();
    const expired = () => new Error('Desktop workspace verification timed out; queued updates may still apply.');
    if (remaining <= 0) throw expired();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(expired()), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const request = (method, params) => bounded(() => rpc(method, params));
  const target = normalizeConversationWorkspace(workspace);
  let before = checkedThread(await request('thread/read', { threadId, includeTurns: false }), threadId);
  checkedWorkspaceTransferThread(before);
  if (before.projectId !== projectId) throw new Error('The project association changed before the desktop workspace update; no update was sent.');
  const originalCwd = before.cwd;
  const original = normalizeConversationWorkspace(originalCwd);
  const result = { threadId, workspace: target.display, originalCwd, changed: false, modelInference: false };
  if (original.key === target.key) return { ...result, verifiedCwd: before.cwd, readBackVerified: true };
  if (before.status.type === 'notLoaded') {
    if (!loadIfNeeded) throw new Error('The conversation is not loaded; no desktop workspace update was sent.');
    // Cold resume can emit an idle lifecycle that continues an active goal.
    // Refuse it instead of treating resume as unconditionally inference-free.
    const goalResult = await request('thread/goal/get', { threadId });
    if (!goalResult || !Object.hasOwn(goalResult, 'goal') || (goalResult.goal !== null &&
      (goalResult.goal.threadId?.toLowerCase() !== threadId ||
        !['paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goalResult.goal.status)))) {
      throw new Error('The conversation has an active or unavailable goal; no read-only workspace resume was sent.');
    }
    // Resume by id only. Native history is preserved and no turn, tool, fork,
    // writer takeover, model override, or imported history is requested.
    const resumed = await request('thread/resume', { threadId, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
    before = checkedThread(resumed, threadId, originalCwd);
    if (resumed.cwd !== originalCwd || resumed.approvalPolicy !== 'never' || resumed.sandbox?.type !== 'readOnly') {
      throw new Error('Codex did not confirm the read-only, never-approval workspace preparation.');
    }
    checkedWorkspaceTransferThread(before);
    if (before.status.type !== 'idle' || before.projectId !== projectId) throw new Error('The conversation was not idle in the expected project after resume; no workspace update was sent.');
  }
  // The response is only a queue acknowledgment ({}). Applied settings and
  // persistence can lag that reply, so verify through a bounded public read.
  await request('thread/settings/update', { threadId, cwd: target.display });
  for (let attempt = 0; attempt < readBackAttempts; attempt += 1) {
    const after = checkedThread(await request('thread/read', { threadId, includeTurns: false }), threadId);
    if (after.projectId !== projectId) throw new Error('The project association changed during desktop workspace verification.');
    checkedWorkspaceTransferThread(after);
    const current = normalizeConversationWorkspace(after.cwd);
    if (current.key === target.key) return { ...result, changed: true, verifiedCwd: after.cwd, readBackVerified: true };
    if (current.key !== original.key) throw new Error('The conversation moved to an unexpected directory during desktop workspace verification.');
    if (attempt + 1 < readBackAttempts) await bounded(() => wait(readBackDelayMs));
  }
  throw new Error('The desktop workspace update was queued but remained unverified before the deadline; it may still apply.');
}

/**
 * Execute one Aura turn through the public Codex app-server protocol.
 * New threads are persisted by Codex itself; neither its database nor rollout
 * files are edited here. clientInfo identifies this integration truthfully.
 * `args` contains only caller-owned CLI config overrides, before app-server.
 * Callbacks emit legacy exec-shaped events as well as optional text callbacks.
 */
export async function runAppServerTurn({
  cli, args = [], cwd, env = process.env, threadId: resumeId = '', userText,
  developerInstructions = '', model = 'gpt-6.1-sol', reasoning = 'ultra',
  policy = { sandbox: 'read-only' }, signal, timeoutMs = 900_000,
  workspaceSyncTimeoutMs = 5000,
  ephemeral = false, title, migrateLegacy = true, conversationWorkspace, onEvent = () => {}, onThread = () => {},
  onText, emitText, onReasoning, emitReasoning,
}) {
  if (signal?.aborted) throw new Error('Codex 请求已取消。');
  if (!cli?.command || !path.isAbsolute(cwd || '') || typeof userText !== 'string' || !userText.trim()) throw new Error('Invalid Aura app-server invocation.');
  if (resumeId && !UUID.test(resumeId)) throw new Error('Invalid Codex thread ID.');
  if (!['read-only', 'workspace-write'].includes(policy.sandbox)) throw new Error('Unsupported Aura sandbox policy.');
  if (!Array.isArray(args) || args.some(v => typeof v !== 'string')) throw new Error('Invalid Codex arguments.');

  const child = spawn(cli.command, [...(cli.prefixArgs || []), ...args, 'app-server', '--stdio'], {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(), texts = new Map(), completedItems = new Set();
  let seq = 0, buffer = '', stderr = '', threadId = '', turnId = '', source, previousThreadId;
  let answer = '', terminalError, turnFinished = false, closing = false;
  let finishTurn, rejectTurn;
  const completion = new Promise((resolve, reject) => { finishTurn = resolve; rejectTurn = reject; });
  // Errors can arrive while initialize/thread/start is still awaiting its RPC.
  completion.catch(() => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  const event = value => onEvent(value);
  const fail = error => {
    if (terminalError) return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    for (const p of pending.values()) p.reject(terminalError);
    pending.clear(); rejectTurn(terminalError);
    void killOwnedTree(child);
  };
  const send = value => {
    if (terminalError) throw terminalError;
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (terminalError) { reject(terminalError); return; }
    const id = ++seq; pending.set(id, { resolve, reject });
    try { send({ id, method, params }); } catch (e) { pending.delete(id); reject(e); }
  });
  const publishText = (kind, id, value, append = false) => {
    const key = `${kind}:${id}`, previous = texts.get(key) || '';
    const full = append ? previous + value : value;
    const delta = full.startsWith(previous) ? full.slice(previous.length) : `\n${full}`;
    texts.set(key, full);
    if (!delta) return;
    let prefix = '';
    if (kind === 'agent_message') {
      prefix = previous ? '' : answer ? '\n\n' : '';
      answer += prefix + delta;
      (onText || emitText)?.(prefix + delta);
    } else (onReasoning || emitReasoning)?.(delta);
    event({ type: 'item.updated', item: { id, type: kind, text: full } });
  };
  const publishItem = (item, type) => {
    if (!item || typeof item.id !== 'string') return;
    // A completed item appears both in its item notification and in the final
    // turn payload. Preserve a single operational event for bridge consumers.
    if (type === 'item.completed') {
      if (completedItems.has(item.id)) return;
      completedItems.add(item.id);
    }
    if (item.type === 'agentMessage') {
      if (typeof item.text === 'string') publishText('agent_message', item.id, item.text);
      event({ type, item: { ...item, type: 'agent_message', text: texts.get(`agent_message:${item.id}`) || item.text || '' } });
      return;
    }
    if (item.type === 'reasoning') {
      const summaries = Array.isArray(item.summary) ? item.summary.filter(v => typeof v === 'string').join('\n') : '';
      if (summaries) publishText('reasoning', item.id, summaries);
      event({ type, item: { ...item, type: 'reasoning', text: texts.get(`reasoning:${item.id}`) || summaries } });
      return;
    }
    const itemTypes = { commandExecution: 'command_execution', mcpToolCall: 'mcp_tool_call', fileChange: 'file_change' };
    event({ type, item: { ...item, type: itemTypes[item.type] || item.type } });
  };
  const consume = line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { throw new Error('Codex 返回了无效的 JSON 事件。'); }
    if (message.id !== undefined && !message.method) {
      const p = pending.get(message.id); if (!p) return;
      pending.delete(message.id);
      if (message.error) p.reject(new Error(`Codex app-server: ${message.error.message || JSON.stringify(message.error)}`));
      else p.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const result = declinedRequest(message.method);
      if (result !== undefined) {
        send({ id: message.id, result });
        event({ type: 'approval.declined', method: message.method });
      } else send({ id: message.id, error: { code: -32601, message: 'Aura cannot handle this interactive request.' } });
      return;
    }
    const p = message.params || {};
    if (p.threadId && threadId && p.threadId !== threadId) return;
    if (p.turnId && turnId && p.turnId !== turnId) return;
    switch (message.method) {
      case 'turn/started': turnId = p.turn?.id || turnId; event({ type: 'turn.started', turn_id: turnId }); break;
      case 'item/started': publishItem(p.item, 'item.started'); break;
      case 'item/completed': publishItem(p.item, 'item.completed'); break;
      case 'item/agentMessage/delta': publishText('agent_message', p.itemId, String(p.delta || ''), true); break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': publishText('reasoning', p.itemId, String(p.delta || ''), true); break;
      case 'turn/completed': {
        const turn = p.turn;
        if (!turn || typeof turn.status !== 'string') throw new Error('Codex returned an invalid completed turn.');
        for (const item of turn.items || []) publishItem(item, 'item.completed');
        turnFinished = true;
        if (turn.status !== 'completed') {
          const failure = turn.error?.message || (turn.status === 'interrupted' ? 'Codex 请求已取消。' : 'Codex inference failed.');
          event({ type: 'turn.failed', error: { message: failure } });
          rejectTurn(new Error(failure));
        } else { event({ type: 'turn.completed', usage: turn.usage }); finishTurn(turn); }
        break;
      }
      case 'error':
        // Recoverable retries carry willRetry=true; the final turn owns failure.
        if (!p.willRetry) fail(new Error(p.error?.message || p.message || 'Codex app-server error.'));
        break;
    }
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (terminalError) return;
    buffer += chunk;
    try {
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > MAX_LINE) throw new Error('Codex 事件超过大小限制。');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); consume(line);
      }
      if (buffer.length > MAX_LINE) throw new Error('Codex 事件超过大小限制。');
    } catch (e) { fail(e); }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdin.on('error', e => { if (!closing) fail(e); });
  child.once('error', fail);
  child.once('close', (code, exitSignal) => {
    if (!closing && !terminalError && (!turnFinished || pending.size > 0)) fail(new Error(`Codex app-server disconnected (${code ?? exitSignal}): ${stderr.trim().slice(-1200) || 'No completed turn.'}`));
  });
  const abort = () => {
    if (terminalError || turnFinished) return;
    // Send the public cancellation request before terminating our own process.
    if (threadId && turnId && child.stdin.writable) {
      try { child.stdin.write(`${JSON.stringify({ id: ++seq, method: 'turn/interrupt', params: { threadId, turnId } })}\n`); } catch { /* child is closing */ }
    }
    fail(new Error('Codex 请求已取消。'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => fail(new Error('Codex 请求超时，请缩短任务或稍后重试。')), timeoutMs);
  try {
    await rpc('initialize', { clientInfo: { name: 'codex_aura', title: 'Codex Aura', version: '0.1.5' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const settings = { cwd, model, approvalPolicy: 'never', sandbox: policy.sandbox,
      developerInstructions, config: { model_reasoning_effort: reasoning } };
    let migrate = false;
    if (resumeId && migrateLegacy && !ephemeral) {
      const old = await rpc('thread/read', { threadId: resumeId, includeTurns: false });
      if (old.thread?.id !== resumeId) throw new Error('Codex read an unexpected thread.');
      migrate = ['exec', 'unknown', 'appServer'].includes(old.thread.source);
    }
    // The public fork operation keeps complete native history and leaves the
    // old exec rollout untouched. Forking through this app-server gives Codex's
    // native interactive source; the next explicit turn populates its sidebar
    // preview/index. No manually imported history or database writes are used.
    const start = migrate
      ? await rpc('thread/fork', { ...settings, threadId: resumeId, excludeTurns: true, deferGoalContinuation: true })
      : resumeId ? await rpc('thread/resume', { ...settings, threadId: resumeId, excludeTurns: true })
        : await rpc('thread/start', { ...settings, ephemeral, allowProviderModelFallback: false });
    const thread = start.thread;
    if (!thread || !UUID.test(thread.id || '')) throw new Error('Codex 返回了无效的会话 ID。');
    threadId = thread.id; source = thread.source;
    if (migrate) {
      if (threadId === resumeId || !['cli', 'vscode'].includes(source)) throw new Error('Codex did not create an interactive migration thread; the original was preserved.');
      previousThreadId = resumeId;
    } else if (resumeId && threadId !== resumeId) throw new Error('Codex resumed an unexpected thread.');
    // A newly started native thread may not have a rollout until its first
    // turn is persisted. Record its identity directly from start/resume/fork;
    // sidebar metadata must never prevent the model from running that turn.
    await onThread(threadId, { ...thread,
      ...(previousThreadId ? { previousThreadId } : {}) });
    event({ type: 'thread.started', thread_id: threadId, source, ...(previousThreadId ? { previous_thread_id: previousThreadId } : {}) });
    const sandboxPolicy = policy.sandbox === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      : { type: 'readOnly', networkAccess: false };
    const started = await rpc('turn/start', { threadId, cwd, model, effort: reasoning,
      approvalPolicy: 'never', sandboxPolicy, input: [{ type: 'text', text: userText }] });
    turnId = started.turn?.id || turnId;
    if (!UUID.test(turnId || '')) throw new Error('Codex returned an invalid turn ID.');
    await completion;
    if (terminalError) throw terminalError;
    if (!answer.trim()) throw new Error('Codex 完成了本轮，但没有返回文字。');
    let conversationProject, desktopWorkspace;
    const association = {};
    // The entire optional metadata path has its own deadline, including
    // project reads, mutations and callback persistence, not just cwd reads.
    const syncDeadline = Date.now() + workspaceSyncTimeoutMs;
    const optional = async action => {
      const remaining = syncDeadline - Date.now();
      if (remaining <= 0) throw new Error('Optional native metadata synchronization timed out.');
      let syncTimer;
      try {
        return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
          syncTimer = setTimeout(() => reject(new Error('Optional native metadata synchronization timed out.')), remaining);
        })]);
      } finally { clearTimeout(syncTimer); }
    };
    const syncRpc = async (method, params) => {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try { return await optional(() => rpc(method, params)); }
        catch (error) {
          // Completed native turns can briefly precede rollout materialization.
          // Retry only that exact read error for this known thread. Identity,
          // permission and history errors, and every mutation, stay fail-fast.
          const transient = method === 'thread/read' && params?.threadId === threadId &&
            typeof error?.message === 'string' && error.message.includes(`no rollout found for thread id ${threadId}`);
          if (!transient || attempt === 24) throw error;
          await optional(() => new Promise(resolve => setTimeout(resolve, 100)));
        }
      }
    };
    const workspaceFailure = () => {
      const error = 'The desktop workspace could not be verified through public Codex APIs.';
      desktopWorkspace = { threadId, workspace: conversationWorkspace, originalCwd: cwd,
        readBackVerified: false, modelInference: false, error };
      event({ type: 'workspace-sync-failed', thread_id: threadId, error: { message: error } });
    };
    if (!ephemeral && conversationWorkspace) {
      try {
        conversationProject = await linkConversationProject({ threadId, workspace: conversationWorkspace },
          { rpc: syncRpc, missingProject: 'skip' });
        association.conversationProject = conversationProject;
        association.nativeProjectId = conversationProject.skipped ? conversationProject.previousProjectId : conversationProject.projectId;
        if (!conversationProject.skipped && conversationProject.readBackVerified) {
          try {
            desktopWorkspace = await setConversationDesktopWorkspace({ threadId, workspace: conversationProject.workspace,
              projectId: conversationProject.projectId }, { rpc: syncRpc, verificationTimeoutMs: workspaceSyncTimeoutMs });
          } catch { workspaceFailure(); }
        }
        // Enrich the already saved native identity only after durable metadata
        // is available. Preserve source and migration ancestry on this callback.
        await optional(() => onThread(threadId, { ...thread, ...association,
          ...(conversationProject.readBackVerified ? { projectId: conversationProject.projectId } : {}),
          ...(desktopWorkspace ? { desktopWorkspace } : {}), ...(previousThreadId ? { previousThreadId } : {}) }));
      } catch {
        // The model turn is already durable and complete. Keep its answer even
        // when optional project grouping or callback persistence fails.
        if (!conversationProject) association.conversationProject = { threadId, workspace: conversationWorkspace,
          originalCwd: cwd, readBackVerified: false, modelInference: false,
          error: 'The project association could not be verified through public Codex APIs.' };
        if (!desktopWorkspace?.error) workspaceFailure();
      }
    }
    if (!ephemeral && (!resumeId || migrate || title)) {
      const name = title || `Aura · ${path.basename(cwd)} · ${userText.replace(/\s+/g, ' ').slice(0, 60)}`;
      try { await syncRpc('thread/name/set', { threadId, name }); }
      catch { event({ type: 'thread-name-sync-failed', thread_id: threadId,
        error: { message: 'The completed conversation title could not be synchronized through public Codex APIs.' } }); }
    }
    return { answer, threadId, turnId, source, ...association,
      ...(desktopWorkspace ? { desktopWorkspace } : {}), ...(previousThreadId ? { previousThreadId } : {}) };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    closing = true;
    // EOF lets Codex flush its native history before exit. A broken server or
    // hanging MCP child is bounded, and only this invocation's tree is killed.
    if (!child.stdin.destroyed) child.stdin.end();
    let closeTimer;
    await Promise.race([closed, new Promise(resolve => { closeTimer = setTimeout(resolve, 1500); })]);
    clearTimeout(closeTimer);
    await killOwnedTree(child);
    for (const p of pending.values()) p.reject(new Error('Codex app-server closed.'));
    pending.clear();
  }
}
