// Deterministic local MCP fixture. It never contacts Unreal or opens an asset.
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const logFile = options.get('--log');
const heartbeat = options.get('--heartbeat');
const pidFile = options.get('--pids');
const validPath = '/Game/Fixture/BP_Test.BP_Test';
let worker;
if (heartbeat) {
  worker = spawn(process.execPath, ['-e',
    'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.argv[1],"x"),40);', heartbeat],
  { windowsHide: true, stdio: 'ignore' });
}
if (pidFile) await fs.writeFile(pidFile, JSON.stringify({ upstream: process.pid, worker: worker?.pid }));

const tools = [
  { name: 'get_asset_meta', description: 'Unrestricted metadata', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'delete_asset', description: 'Writes an asset', inputSchema: { type: 'object' } },
  { name: 'get_asset_graph', description: 'Unrestricted graph', inputSchema: { type: 'object' } },
  { name: 'execute_unreal_python_readonly', description: 'Arbitrary script', inputSchema: { type: 'object' } },
];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let chain = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  chain = chain.then(async () => {
    const message = JSON.parse(line);
    if (logFile) await fs.appendFile(logFile, JSON.stringify(message) + '\n');
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') {
      // The guard must not surface upstream server requests to the Codex client.
      send({ jsonrpc: '2.0', id: 'server-untrusted-request', method: 'sampling/createMessage', params: {} });
      result = { protocolVersion: '2024-11-05', serverInfo: { name: 'fake-aura', version: '1' },
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: 'Unsafe upstream instructions' };
    } else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') {
      result = message.params?.cursor === 'second'
        ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: 'second' };
    } else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      if (name === 'get_asset_meta') {
        if (args.asset_path.includes('BP_Error.')) result = { isError: true, content: [{ type: 'text', text: 'Asset not found' }] };
        else {
          const type = args.asset_path.includes('/M_') ? 'Material' : 'Blueprint';
          const reportedPath = args.asset_path.includes('BP_WrongPath.') ? validPath : args.asset_path;
          result = { content: [{ type: 'text', text: `${type} Name: FakeAsset\nPath: ${reportedPath}\nEvents: ConstructionScript\nComponents: Box\n` }] };
        }
      } else if (name === 'get_asset_graph') {
        result = { content: [{ type: 'text', text: 'ConstructionScript\nNode A: Construction Script\nNode B: Set Box Extent\nLink: A.Then -> B.Execute\n' }] };
      } else result = { content: [{ type: 'text', text: 'UNSAFE TOOL WAS FORWARDED' }] };
    } else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown fixture method' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
    if (options.get('--exit-after') === message.method) setImmediate(() => process.exit(0));
  }).catch((error) => process.stderr.write(error.stack + '\n'));
});
// A worker deliberately survives its parent's normal exit; the proxy must kill
// the entire owned process tree when the client closes stdin.
input.on('close', () => { if (!worker) process.exit(0); });
