import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const log = async (value) => { if (process.env.FAKE_CODEX_LOG) await fs.appendFile(process.env.FAKE_CODEX_LOG, JSON.stringify(value) + '\n'); };
if (args.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (args.includes('mcp') && args.includes('list')) {
  console.log(JSON.stringify([{ name: 'code-review', enabled: false }, { name: 'node_repl', enabled: true }, { name: 'unreal_editor', enabled: true }, { name: 'unreal_inspector', enabled: true }]));
  process.exit(0);
}
if (args.includes('plugin') && args.includes('list')) {
  console.log(JSON.stringify({ marketplaces: [{ plugins: [
    { pluginId: 'codex-aura@aura-local', installed: true, enabled: true },
    { pluginId: 'untrusted-write@fixture', installed: true, enabled: true },
    { pluginId: 'uninstalled@fixture', installed: false, enabled: false },
  ] }] }));
  process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
await log({ kind: 'exec', args, prompt, cwd: process.cwd(), at: Date.now() });
const scenario = process.env.FAKE_CODEX_SCENARIO || 'ok';
if (scenario === 'exit') { console.error('Login expired. Run codex login.'); process.exit(7); }
if (scenario === 'invalid') { console.log('not valid JSON'); setInterval(() => {}, 1000); }
else if (scenario === 'hang') {
  if (process.env.FAKE_CODEX_HEARTBEAT) {
    // A child heartbeat exercises process-tree cancellation, not only parent kill.
    spawn(process.execPath, ['-e', 'const fs=require("fs");setInterval(()=>fs.appendFileSync(process.env.FAKE_CODEX_HEARTBEAT,"x"),50)'],
      { env: process.env, windowsHide: true, stdio: 'ignore' });
  }
  setInterval(() => {}, 1000);
} else {
  const resumed = args.includes('resume');
  const thread = resumed ? args.find((a) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(a)) : randomUUID();
  const events = [
    { type: 'thread.started', thread_id: thread },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Reviewing supplied context.' } },
    { type: 'item.updated', item: { id: 'a1', type: 'agent_message', text: '你好' } },
    { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: `你好 ${resumed ? 'continued' : 'new'}` } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
  ];
  if (scenario === 'failed') {
    events.splice(3, events.length, { type: 'turn.failed', error: { message: 'Quota exceeded.' } });
  }
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  process.stdout.write(text.slice(0, 37));
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.stdout.write(text.slice(37));
}
