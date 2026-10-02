import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
const values = new Map();
for (let i = 2; i < process.argv.length; i += 2) values.set(process.argv[i], process.argv[i + 1]);
const log = values.get('--log');
const mode = values.get('--mode');
let worker;
if (values.get('--heartbeat')) worker = spawn(process.execPath, ['-e', 'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.argv[1],"x"),30)', values.get('--heartbeat')], { windowsHide: true, stdio: 'ignore' });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  queue = queue.then(async () => {
    const message = JSON.parse(line);
    if (log) await fs.appendFile(log, JSON.stringify(message) + '\n');
    if (message.id === undefined) return;
    if (mode === 'hang' && message.method === 'tools/list') return;
    if (mode === 'hang-call' && message.method === 'tools/call') return;
    let result;
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: 'untrusted-sampling', method: 'sampling/createMessage', params: { secret: 'MCP_SECRET_DO_NOT_EXPOSE' } });
      result = { protocolVersion: '2024-11-05', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } };
    } else if (message.method === 'tools/list') {
      result = message.params?.cursor === 'second' ? { tools: [
        { name: 'delete_asset', inputSchema: { type: 'object' } },
        { name: 'get_asset_graph', inputSchema: { type: 'object' } },
      ] } : { tools: [
        { name: 'get_asset_meta', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      ], nextCursor: 'second' };
      if (mode === 'cursor-loop') result.nextCursor = 'second';
    } else if (message.method === 'tools/call') {
      const args = message.params.arguments;
      if (message.params.name === 'get_asset_meta') {
        if (args.asset_path.includes('BP_Error.')) {
          send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Fixture asset not found' }] } });
          return;
        }
        const assetType = args.asset_path.includes('/M_') ? 'Material' : 'Blueprint';
        result = { content: [{ type: 'text', text: `${assetType} Name: Fixture\nPath: ${args.asset_path}\nFunctions: Construction Script\nComponents: Box\n` }] };
      } else result = { content: [{ type: 'text', text: 'UserConstructionScript\nNode A Then -> Node B Execute\n' }] };
    } else result = {};
    send({ jsonrpc: '2.0', id: message.id, result });
  }).catch(() => {});
});
lines.on('close', () => { if (!worker) void queue.then(() => process.exit(0)); });
