// Real custom MCP -> existing Bridge -> actual Figma plugin. No official Figma tools.
// Default is read-only. --create requires locally enabled plugin permission.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'phase2-live', version: '0.2.0' });
const report = { timestamp: new Date().toISOString(), checks: [], created: null };
const read = r => { assert(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
async function call(name, args = {}) { return read(await client.callTool({ name, arguments: args })); }
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp-server/dist/index.js')], env: { ...process.env, FIGMA_BRIDGE_TOKEN_FILE: resolve('.bridge/token') }, stderr: 'pipe' }));
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  const status = await call('figma_get_status');
  assert(status.online && status.sessions.length === 1, 'Expected one online real plugin');
  const sessionId = status.sessions[0].sessionId;
  const document = await call('figma_get_document', { sessionId, limit: 3, depth: 1, fields: ['name','geometry'] });
  assert(document.ok && document.data.nodes.length <= 3);
  report.checks.push({ tool: 'figma_get_document', context: document.data.context, count: document.data.nodes.length, pages: document.data.pages });
  const selection = await call('figma_get_selection', { sessionId, limit: 3 });
  assert(selection.ok); report.checks.push({ tool: 'figma_get_selection', count: selection.data.nodes.length });
  if (document.data.nextCursor !== null) {
    const next = await call('figma_get_document', { sessionId, cursor: document.data.nextCursor, depth: 1, limit: 3 });
    assert(next.ok); assert(!next.data.nodes.some(n => document.data.nodes.some(first => first.id === n.id)));
    report.checks.push({ tool: 'pagination', count: next.data.nodes.length });
  }
  if (document.data.nodes.length) {
    const ids = [document.data.nodes[0].id];
    const found = await call('figma_get_nodes', { sessionId, ids, fields: ['name'] });
    assert(found.ok && found.data.nodes[0].id === ids[0]); report.checks.push({ tool: 'figma_get_nodes', count: found.data.nodes.length });
  }
  const query = await call('figma_find_nodes', { sessionId, depth: 2, limit: 3, types: ['FRAME'] });
  assert(query.ok && query.data.nodes.every(n => n.type === 'FRAME'));
  report.checks.push({ tool: 'figma_find_nodes', count: query.data.nodes.length });
  if (process.argv.includes('--create')) {
    assert(status.sessions[0].context.writeEnabled, 'Enable write permission in the plugin first');
    // Place a new isolated frame to the right of all current top-level content.
    let right = 0, cursor = 0;
    for (let i = 0; i < 500; i++) {
      const page = await call('figma_get_document', { sessionId, depth: 1, limit: 50, cursor, fields: ['geometry'] });
      assert(!page.data.truncated, 'Page exceeds scan bound; choose a placement manually');
      for (const n of page.data.nodes) right = Math.max(right, (n.x ?? 0) + (n.width ?? 0));
      if (page.data.nextCursor === null) break;
      cursor = page.data.nextCursor;
      if (i === 499) throw new Error('Placement scan too large');
    }
    const requestId = `phase2-${randomUUID()}`;
    const operations = [
      { op: 'create', type: 'TEXT', ref: 'title', parent: '$phone', name: 'Acceptance title', characters: 'Figma AI Bridge', x: 24, y: 32, fontSize: 24, fill: { r: .1, g: .13, b: .2 } },
      { op: 'create', type: 'FRAME', ref: 'phone', name: `AI Bridge · Phase 2 · ${new Date().toISOString()}`, x: right + 100, y: 0, width: 390, height: 844, fill: { r: .96, g: .97, b: .99 } },
      { op: 'create', type: 'RECTANGLE', ref: 'search', parent: '$phone', name: 'Search background', x: 24, y: 94, width: 342, height: 48, cornerRadius: 12, fill: { r: 1, g: 1, b: 1 } },
      { op: 'create', type: 'TEXT', parent: '$phone', name: 'Search label', characters: 'Search designs', x: 40, y: 108, fontSize: 16, fill: { r: .4, g: .45, b: .5 } },
      ...[0,1,2].map(i => ({ op: 'create', type: 'FRAME', ref: `card${i}`, parent: '$phone', name: `Card ${i+1}`, x: 24, y: 170 + i*164, width: 342, height: 144, cornerRadius: 16, fill: { r: 1, g: 1, b: 1 } })),
      ...[0,1,2].map(i => ({ op: 'create', type: 'TEXT', parent: `$card${i}`, name: `Card title ${i+1}`, characters: `Editable card ${i+1}`, x: 20, y: 24, fontSize: 20, fill: { r: .1, g: .13, b: .2 } })),
      { op: 'create', type: 'RECTANGLE', ref: 'nav', parent: '$phone', name: 'Bottom navigation', x: 0, y: 760, width: 390, height: 84, fill: { r: .12, g: .25, b: .8 } },
      { op: 'create', type: 'TEXT', parent: '$phone', name: 'Navigation label', characters: 'Home          Explore          Profile', x: 24, y: 789, fontSize: 16, fill: { r: 1, g: 1, b: 1 } },
      { op: 'create', type: 'ELLIPSE', ref: 'badge', parent: '$card0', name: 'Native ellipse badge', x: 286, y: 96, width: 32, height: 32, fill: { r: .12, g: .25, b: .8 } }
    ];
    const created = await call('figma_execute', { sessionId, requestId, operations });
    assert(created.ok && created.data.complete && created.data.created.length === operations.length);
    const replay = await call('figma_execute', { sessionId, requestId, operations });
    assert.deepEqual(replay.data.created, created.data.created);
    const check = await call('figma_get_nodes', { sessionId, ids: created.data.created.map(n => n.id), fields: ['name','parentId','geometry','characters','fills'] });
    const phone = check.data.nodes.find(n => n.id === created.data.refs.phone);
    const title = check.data.nodes.find(n => n.id === created.data.refs.title);
    assert(phone.type === 'FRAME' && phone.width === 390 && phone.height === 844);
    assert(title.type === 'TEXT' && title.characters === 'Figma AI Bridge' && title.parentId === phone.id);
    assert(check.data.nodes.some(n => n.type === 'ELLIPSE'));
    report.created = { requestId, result: created.data, readback: check.data.nodes };
  }
  console.log(JSON.stringify(report, null, 2));
  await mkdir('.bridge', { recursive: true });
  await writeFile(resolve('.bridge/phase2-live-report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: Phase 2 real read acceptance${report.created ? ' + native creation/readback/idempotent replay' : ''}`);
} finally { await client.close(); }
