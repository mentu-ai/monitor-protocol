// Read-only MCP fixture for codex-capability-trial.mjs. No model, network, or desktop actions.
import { createInterface } from 'node:readline';
export const tool = { name: 'read_probe', description: 'Read the fixed continuity probe.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'continuity-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [tool] };
  else if (request.method === 'tools/call' && request.params.name === tool.name) result = {
    content: [{ type: 'text', text: JSON.stringify({ fixture: 'continuity-v1', total: 64 }) }],
    structuredContent: { fixture: 'continuity-v1', total: 64 }, isError: false };
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n'); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
