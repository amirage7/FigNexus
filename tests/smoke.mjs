// Actual loopback Bridge + stdio MCP child processes; simulated plugin, never Figma.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const token = randomBytes(32).toString('hex');
await mkdir('.bridge', { recursive: true });
const tokenFile = resolve(`.bridge/smoke-${process.pid}.token`);
const imageFile=resolve(`.bridge/smoke-${process.pid}.png`);
await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
const auditDir=resolve(`.bridge/smoke-${process.pid}-audit`);
const env = { ...process.env, FIGMA_BRIDGE_TOKEN_FILE: tokenFile,FIGMA_BRIDGE_AUDIT_DIR:auditDir,FIGMA_BRIDGE_PREVIEW_DIR:resolve(auditDir,'previews'),FIGMA_BRIDGE_AUTOSTART:'0' };
const bridge = spawn(process.execPath, ['apps/bridge-server/dist/index.js'], { env, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
let bridgeError = '';
bridge.stderr.on('data', d => { bridgeError += d.toString(); });
const client = new Client({ name: 'phase-1-acceptance', version: '0.1.0' });
let socket;
const read = r => JSON.parse(r.content[0].text);
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (bridge.exitCode !== null) throw new Error(`Bridge exited: ${bridgeError}`);
    try { const r = await fetch('http://127.0.0.1:3055/v1/status', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) }); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert(ready, 'Bridge startup failed (port 3055 must be free)');
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['packages/mcp-server/dist/index.js'], env, stderr: 'pipe' }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['figma_create_frame','figma_create_text','figma_create_rectangle','figma_create_nodes','figma_execute','figma_export_preview','figma_find_nodes','figma_get_audit_status','figma_get_document','figma_get_nodes','figma_get_selection','figma_get_status','figma_list_backups','figma_ping','figma_restore_backup','figma_import_image','figma_list_components','figma_create_component','figma_create_instance','figma_list_variables','figma_create_variable_collection','figma_create_variable','figma_set_variable','figma_bind_variable','figma_get_variable_history','figma_restore_variable','figma_list_pages','figma_create_page','figma_switch_page'].sort());
  assert.equal(read(await client.callTool({ name: 'figma_get_status' })).online, false);
  const context = { instanceId: 'smoke-plugin', document: { id: '0:0', name: 'SIMULATED FILE' }, page: { id: '0:1', name: 'SIMULATED PAGE' },writeEnabled:true };
  socket = new WebSocket('ws://127.0.0.1:3055/v1/ws');
  await new Promise((yes, no) => { socket.once('open', yes); socket.once('error', no); });
  const welcome = new Promise((yes, no) => { socket.once('message', d => yes(JSON.parse(d.toString()))); socket.once('error', no); });
  socket.send(JSON.stringify({ type: 'hello', version: 1, token, context }));
  const { sessionId } = await welcome;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=','base64');
  await writeFile(imageFile,png,{flag:'wx'});
  const uploads=new Map();
  socket.on('message', d => { const r = JSON.parse(d.toString()); if (r.type === 'request') {
    if(r.method==='design'||r.method==='image_upload'){
      let extra;if(r.method==='design')extra={design:{action:r.params.action,pages:[context.page],nextCursor:null,truncated:false,scanned:1}};
      else {const p=r.params,received=(uploads.get(p.uploadId)??0)+Buffer.from(p.base64,'base64').length;uploads.set(p.uploadId,received);const complete=p.index===p.totalChunks-1;extra={image:{uploadId:p.uploadId,index:p.index,receivedBytes:received,complete,...(complete?{imageHash:'smoke-image-hash'}:{})}};}
      socket.send(JSON.stringify({type:'result',requestId:r.requestId,ok:true,data:{context,complete:true,created:[],refs:{},completed:r.method==='design'?[]:[0],backups:[],skipped:[],...extra}}));return;
    }
    const data=r.method==='list_backups'?{context,backups:[{version:1,backupId:'backup',nodeId:'source',parentId:'0:1',index:0,pageId:'0:1',createdAt:new Date().toISOString()}],nextCursor:null,truncated:false,scanned:2}:r.method==='restore_backup'?{context,complete:true,created:[{index:0,id:'restored-copy',type:'RECTANGLE'}],refs:{},completed:[0],backups:[],skipped:[]}:r.method==='export_preview'?{exportId:'smoke-export',nodeId:r.params.nodeId,totalBytes:png.length,chunks:1}:r.method==='preview_chunk'?{exportId:'smoke-export',index:0,base64:png.toString('base64')}:{pong:true,context};
    socket.send(JSON.stringify({ type: 'result', requestId: r.requestId, ok: true, data }));
  } });
  const status = read(await client.callTool({ name: 'figma_get_status' }));
  assert.equal(status.online, true); assert.equal(status.sessions[0].sessionId, sessionId);
  const ping = await client.callTool({ name: 'figma_ping', arguments: { sessionId, requestId: 'smoke-ping' } });
  assert.equal(ping.isError, false); assert.deepEqual(read(ping).data.context, context);
  const pages=await client.callTool({name:'figma_list_pages',arguments:{sessionId}});assert(!pages.isError);assert.equal(read(pages).data.design.pages[0].id,context.page.id);
  const image=await client.callTool({name:'figma_import_image',arguments:{sessionId,expectedPageId:context.page.id,path:imageFile,requestId:'smoke-image'}});assert(!image.isError);assert.equal(read(image).data.image.imageHash,'smoke-image-hash');
  const backups=read(await client.callTool({name:'figma_list_backups',arguments:{sessionId}}));assert.equal(backups.data.backups[0].backupId,'backup');
  const restored=await client.callTool({name:'figma_restore_backup',arguments:{sessionId,requestId:'smoke-restore',backupId:'backup',parentId:'0:1'}});assert(!restored.isError);assert.equal(read(restored).data.created[0].id,'restored-copy');
  const replay=await client.callTool({name:'figma_restore_backup',arguments:{sessionId,requestId:'smoke-restore',backupId:'backup',parentId:'0:1'}});assert.deepEqual(read(replay),read(restored));
  const audit=read(await client.callTool({name:'figma_get_audit_status'}));assert(audit.enabled&&audit.healthy);assert(audit.recent.some(e=>e.requestId==='smoke-restore'&&e.state==='complete'));
  const preview=await client.callTool({name:'figma_export_preview',arguments:{sessionId,nodeId:'smoke-frame'}});
  assert(!preview.isError);assert.equal(preview.content[1].type,'image');assert.equal(preview.content[1].data,png.toString('base64'));
  const resource=await client.readResource({uri:JSON.parse(preview.content[0].text).resourceUri});assert.equal(resource.contents[0].blob,png.toString('base64'));
  await new Promise(r => { socket.once('close', r); socket.close(); });
  for (let i = 0; i < 20; i++) {
    if (!read(await client.callTool({ name: 'figma_get_status' })).online) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(read(await client.callTool({ name: 'figma_get_status' })).online, false);
  assert.equal((await client.callTool({ name: 'figma_ping', arguments: { sessionId } })).isError, true);
  console.log('PASS: real Bridge + stdio MCP initialize/25 tools/status/ping/native-design/image-import/backup catalog/restore/replay/durable audit/PNG resource/disconnect; simulated plugin only.');
} finally {
  socket?.terminate(); await client.close();
  if (bridge.exitCode === null) { const exited = new Promise(r => bridge.once('exit', r)); bridge.kill(); await exited; }
  await unlink(tokenFile);
  await unlink(imageFile).catch(()=>{});
  if(auditDir.startsWith(resolve('.bridge')+'/')||auditDir.startsWith(resolve('.bridge')+'\\'))await rm(auditDir,{recursive:true,force:true});
}
