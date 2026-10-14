// Run only after the human approves the pending disposable-node deletion in Figma.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const intent=JSON.parse(await readFile('.bridge/delete-intent.json','utf8'));
assert.equal(intent.operations.length,1);
assert.equal(intent.operations[0].op,'delete');
const client=new Client({name:'delete-live',version:'0.4.0'});
const read=r=>{assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp-server/dist/index.js')],env:{...process.env,FIGMA_BRIDGE_TOKEN_FILE:resolve('.bridge/token')},stderr:'pipe'}));
  const status=read(await client.callTool({name:'figma_get_status',arguments:{}}));
  const matches=status.sessions.filter(s=>process.env.FIGMA_ACCEPT_INSTANCE_ID?s.context.instanceId===process.env.FIGMA_ACCEPT_INSTANCE_ID:s.sessionId===(process.env.FIGMA_ACCEPT_SESSION_ID??intent.sessionId));
  assert.equal(matches.length,1,'Original deletion session must still be online; inspect before using a replacement session');
  let sessionId=matches[0].sessionId;
  const runtime=matches[0].context.instanceId,pageId=matches[0].context.page.id;
  const deadline=Date.now()+120000;
  let response=await client.callTool({name:'figma_execute',arguments:{...intent,sessionId}});
  // Reconnection is safe only in this exact plugin runtime, which retains write IDs.
  while(process.argv.includes('--wait-for-confirmation')&&response.isError&&Date.now()<deadline){
    const problem=JSON.parse(response.content[0].text);
    if(problem.error?.code!=='CONFIRMATION_REQUIRED'&&!(problem.code==='REQUEST_FAILED'&&problem.message==='Bridge 409: OFFLINE'))break;
    console.log('Waiting for local plugin approval of node '+intent.operations[0].target);
    await new Promise(resolve=>setTimeout(resolve,2000));
    const current=read(await client.callTool({name:'figma_get_status',arguments:{}}));
    const same=current.sessions.filter(s=>s.context.instanceId===runtime&&s.context.page.id===pageId);
    if(!same.length)continue;
    assert.equal(same.length,1);sessionId=same[0].sessionId;
    response=await client.callTool({name:'figma_execute',arguments:{...intent,sessionId}});
  }
  const result=read(response);
  assert(result.ok&&result.data.complete);
  assert.equal(result.data.backups.length,1);
  const nodeId=intent.operations[0].target,backupId=result.data.backups[0].backupId;
  const after=read(await client.callTool({name:'figma_get_nodes',arguments:{sessionId,ids:[nodeId,backupId],fields:['name','parentId']}}));
  assert(after.data.missing.includes(nodeId));assert(after.data.nodes.some(n=>n.id===backupId));
  await writeFile('.bridge/delete-live-report.json',JSON.stringify({timestamp:new Date().toISOString(),requestId:intent.requestId,nodeId,backupId,result},null,2));
  console.log('PASS: confirmed disposable deletion and native backup readback');
} finally { await client.close(); }
