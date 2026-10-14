// Actual editable-node acceptance against only the isolated Phase 2 generated frame.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'phase34-live',version:'0.4.0'});
const evidence=JSON.parse(await readFile('.bridge/phase2-live-report.json','utf8'));
const refs=evidence.created.result.refs;
const read=r=>{assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const report={timestamp:new Date().toISOString(),frameId:refs.phone,checks:[],previews:[]};
async function call(name,args={}){return read(await client.callTool({name,arguments:args}));}
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp-server/dist/index.js')],env:{...process.env,FIGMA_BRIDGE_TOKEN_FILE:resolve('.bridge/token')},stderr:'pipe'}));
  const status=await call('figma_get_status');
  const matches=status.sessions.filter(s=>process.env.FIGMA_ACCEPT_SESSION_ID?s.sessionId===process.env.FIGMA_ACCEPT_SESSION_ID:s.context.document.name===evidence.created.result.context.document.name&&s.context.page.id===evidence.created.result.context.page.id);
  assert(status.online&&matches.length===1,'One matching acceptance session required; set FIGMA_ACCEPT_SESSION_ID if ambiguous');
  const sessionId=matches[0].sessionId;
  assert.equal(matches[0].context.document.name,evidence.created.result.context.document.name);
  assert.equal(matches[0].context.page.id,evidence.created.result.context.page.id);
  const before=await call('figma_get_nodes',{sessionId,ids:[refs.phone,refs.title,refs.nav,refs.card0,refs.badge],fields:['name','geometry','characters','parentId','fills']});
  assert(before.ok&&before.data.nodes.length===5);
  const phone=before.data.nodes.find(n=>n.id===refs.phone);
  assert.equal(phone.type,'FRAME');assert.equal(phone.width,390);assert.equal(phone.height,844);
  assert.equal(phone.name,evidence.created.readback.find(n=>n.id===refs.phone).name);
  async function preview(label){
    const r=await client.callTool({name:'figma_export_preview',arguments:{sessionId,nodeId:refs.phone,maxSize:1024}});
    const meta=read(r);assert(r.content.some(c=>c.type==='image'&&c.mimeType==='image/png'));
    const resource=await client.readResource({uri:meta.resourceUri});assert.equal(resource.contents[0].blob,r.content.find(c=>c.type==='image').data);
    report.previews.push({label,...meta});
  }
  await preview('before');
  if(!process.argv.includes('--preview-only')){
    assert(matches[0].context.writeEnabled,'Enable local edit permission');
    const requestId=`phase34-${randomUUID()}`;
    const operations=[
      {op:'update',target:refs.title,patch:{characters:'AI Bridge · Updated',fontSize:24}},
      {op:'update',target:refs.nav,patch:{fill:{r:.05,g:.55,b:.32},cornerRadius:0}},
      {op:'clone',target:refs.badge,ref:'copy'},
      {op:'update',target:'$copy',patch:{x:248,y:96,name:'Phase 3 editable copy'}},
      {op:'reparent',target:'$copy',parent:refs.card1},
      {op:'reorder',target:'$copy',index:0},
      {op:'layout',target:refs.card0,layout:{direction:'HORIZONTAL',gap:8,padding:20,primarySizing:'FIXED',counterSizing:'FIXED',primaryAlign:'MIN',counterAlign:'CENTER'}}
    ];
    await writeFile('.bridge/phase34-intent.json',JSON.stringify({sessionId,requestId,operations},null,2));
    const r=await call('figma_execute',{sessionId,requestId,operations});assert(r.ok&&r.data.complete);assert.equal(r.data.completed.length,operations.length);
    const replay=await call('figma_execute',{sessionId,requestId,operations});assert.deepEqual(replay.data,r.data);
    const after=await call('figma_get_nodes',{sessionId,ids:[refs.phone,refs.title,refs.nav,refs.card0,r.data.refs.copy],fields:['name','geometry','characters','parentId','fills']});
    assert.equal(after.data.nodes.find(n=>n.id===refs.title).characters,'AI Bridge · Updated');
    assert.equal(after.data.nodes.find(n=>n.id===refs.nav).fills[0].g,.55);
    assert.equal(after.data.nodes.find(n=>n.id===refs.card0).layoutMode,'HORIZONTAL');
    assert.equal(after.data.nodes.find(n=>n.id===r.data.refs.copy).parentId,refs.card1);
    assert.equal(after.data.nodes.find(n=>n.id===refs.phone).width,390);assert.equal(after.data.nodes.find(n=>n.id===refs.phone).height,844);
    const backup=await call('figma_get_nodes',{sessionId,ids:r.data.backups.map(b=>b.backupId),fields:['characters','parentId','locked']});assert.equal(backup.data.nodes.length,r.data.backups.length);
    report.checks.push({kind:'incremental-edit-clone-reparent-reorder-layout-backup-idempotency',result:r.data,readback:after.data.nodes});
    // Separate harmless disposable node for the human-confirmed deletion acceptance.
    const disposable=await call('figma_execute',{sessionId,requestId:`disposable-${randomUUID()}`,operations:[{op:'create',type:'RECTANGLE',ref:'temporary',parent:refs.phone,name:'Delete confirmation acceptance only',x:350,y:10,width:8,height:8}]});
    const deleteRequest={sessionId,requestId:`delete-${randomUUID()}`,operations:[{op:'delete',target:disposable.data.refs.temporary}]};
    await writeFile('.bridge/delete-intent.json',JSON.stringify(deleteRequest,null,2));
    const confirmation=await client.callTool({name:'figma_execute',arguments:deleteRequest});
    assert(confirmation.isError);const rejected=JSON.parse(confirmation.content[0].text);assert.equal(rejected.error.code,'CONFIRMATION_REQUIRED');
    report.checks.push({kind:'delete-refused-until-local-confirmation',nodeId:disposable.data.refs.temporary,requestId:deleteRequest.requestId});
    await preview('after');
  }
  const previewOnly=process.argv.includes('--preview-only');
  await writeFile(previewOnly?'.bridge/phase4-preview-report.json':'.bridge/phase34-live-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));console.log(previewOnly?'PASS: real Phase 4 PNG/image/resource acceptance; no edits.':'PASS: real Phase 3 editing + Phase 4 PNG/resource acceptance (deletion awaiting human).');
}finally{await client.close();}
