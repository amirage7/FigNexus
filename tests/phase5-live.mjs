// Run once against the new Phase5 build. All write intents/results are saved incrementally.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const path='.bridge/phase5-live-state.json',evidence=JSON.parse(await readFile('.bridge/phase2-live-report.json','utf8'));
const frameId=evidence.created.result.refs.phone;
let state;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const client=new Client({name:'phase5-live',version:'0.5.0'});
const read=r=>{assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const save=()=>writeFile(path,JSON.stringify(state,null,2));
const call=async(name,args={})=>read(await client.callTool({name,arguments:args}));
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp-server/dist/index.js')],env:{...process.env,FIGMA_BRIDGE_TOKEN_FILE:resolve('.bridge/token')},stderr:'pipe'}));
  const status=await call('figma_get_status');
  const matches=status.sessions.filter(s=>process.env.FIGMA_ACCEPT_INSTANCE_ID?s.context.instanceId===process.env.FIGMA_ACCEPT_INSTANCE_ID:s.context.document.name===evidence.created.result.context.document.name&&s.context.page.id===evidence.created.result.context.page.id);
  assert.equal(matches.length,1,'Exactly one matching live plugin required');const runtime=matches[0].context.instanceId;
  assert(matches[0].context.writeEnabled,'Local write permission required');
  if(state)assert.equal(state.runtime,runtime,'Never replay uncertain Phase5 writes after a plugin restart; inspect saved state first');
  else{state={timestamp:new Date().toISOString(),runtime,frameId,requests:{},results:{}};await save();}
  async function session(){const current=await call('figma_get_status');const same=current.sessions.filter(s=>s.context.instanceId===runtime&&s.context.page.id===matches[0].context.page.id);assert.equal(same.length,1,'Keep this plugin runtime/page connected');return same[0].sessionId;}
  const frame=await call('figma_get_nodes',{sessionId:await session(),ids:[frameId],fields:['name','geometry']});assert.equal(frame.data.nodes[0]?.name,evidence.created.readback.find(n=>n.id===frameId).name);
  const audit=await call('figma_get_audit_status');assert(audit.enabled&&audit.healthy,'New durable-audit Bridge required');
  async function write(label,tool,params){
    if(state.results[label])return state.results[label];
    if(!state.requests[label]){state.requests[label]={tool,params,requestId:`phase5-${label}-${randomUUID()}`};await save();}
    const req=state.requests[label];assert.equal(req.tool,tool);assert.deepEqual(req.params,params);
    const result=await call(tool,{sessionId:await session(),requestId:req.requestId,...req.params});
    assert(result.ok&&result.data.complete);state.results[label]=result;await save();return result;
  }
  const created=await write('create','figma_execute',{operations:[{op:'create',type:'RECTANGLE',ref:'source',parent:frameId,name:'Phase 5 restore acceptance only',x:330,y:10,width:8,height:9,fill:{r:.2,g:.6,b:.4}}]});
  const nodeId=created.data.refs.source;
  const updated=await write('update','figma_execute',{operations:[{op:'update',target:nodeId,patch:{width:20}}]});const backupId=updated.data.backups[0].backupId;
  let cursor=0,found;
  do{const list=await call('figma_list_backups',{sessionId:await session(),cursor,limit:50});found=list.data.backups.find(b=>b.backupId===backupId);cursor=list.data.nextCursor;}while(!found&&cursor!==null);
  assert(found&&found.nodeId===nodeId&&found.parentId===frameId);
  const restored=await write('restore','figma_restore_backup',{backupId,parentId:frameId});const copyId=restored.data.created[0].id;assert.notEqual(copyId,nodeId);
  const replay=await call('figma_restore_backup',{sessionId:await session(),requestId:state.requests.restore.requestId,backupId,parentId:frameId});assert.deepEqual(replay.data,restored.data);
  const after=await call('figma_get_nodes',{sessionId:await session(),ids:[nodeId,backupId,copyId],fields:['name','geometry','parentId','fills']});
  const source=after.data.nodes.find(n=>n.id===nodeId),copy=after.data.nodes.find(n=>n.id===copyId),backup=after.data.nodes.find(n=>n.id===backupId);
  assert(source&&copy&&backup);assert.equal(source.width,20);assert.equal(copy.width,8);assert.equal(copy.height,9);assert.equal(copy.parentId,frameId);assert.equal(backup.width,8);
  const logged=await call('figma_get_audit_status');for(const req of Object.values(state.requests))assert(logged.recent.some(e=>e.requestId===req.requestId&&e.state==='complete'));
  const report={timestamp:new Date().toISOString(),runtime,frameId,nodeId,backupId,copyId,results:state.results,readback:after.data,audit:logged};
  await writeFile('.bridge/phase5-live-report.json',JSON.stringify(report,null,2));console.log('PASS: real native metadata catalog + restored copy + original/backup preservation + same-ID replay + durable audit.');
}finally{await client.close();}
