// Read-only acceptance against an already running Bridge and real Figma plugin.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'live-figma-acceptance', version: '0.1.0' });
const read = r => { assert(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp-server/dist/index.js')], env: { ...process.env, FIGMA_BRIDGE_TOKEN_FILE: resolve('.bridge/token') }, stderr: 'pipe' }));
  const status = read(await client.callTool({ name: 'figma_get_status' }));
  console.log(JSON.stringify(status, null, 2));
  assert(status.online && status.sessions.length === 1, 'Expected one online real plugin');
  const result = read(await client.callTool({ name: 'figma_ping', arguments: { sessionId: status.sessions[0].sessionId } }));
  assert(result.ok && result.data.pong);
  console.log(JSON.stringify(result, null, 2));
  console.log('PASS: live custom MCP status + Plugin API ping (read only).');
} finally { await client.close(); }
