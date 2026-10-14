import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBridge} from '../apps/bridge-server/src/server';
import {AuditStore} from '../apps/bridge-server/src/audit';
const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const clean of cleanups.splice(0).reverse())await clean();});
const token='s'.repeat(64),headers={authorization:`Bearer ${token}`},context={instanceId:'audit-plugin',document:{id:'0',name:'PRIVATE FILE'},page:{id:'p',name:'PRIVATE PAGE'},writeEnabled:true};
async function setup(){const dir=await mkdtemp(join(tmpdir(),'phase5-bridge-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));const audit=new AuditStore(dir);await audit.init();const app=await (createBridge as any)(token,false,audit);cleanups.push(()=>app.close());const sessionId=(await app.inject({method:'POST',url:'/v1/connect',headers,payload:{type:'hello',version:1,token,context}})).json().sessionId;return {app,audit,sessionId};}
const request={type:'request',requestId:'write',method:'execute',params:{operations:[{op:'delete',target:'temp'}]}};
const complete={type:'result',requestId:'write',ok:true,data:{context,complete:true,created:[],refs:{},completed:[0],backups:[{nodeId:'temp',backupId:'copy',parentId:'p',index:0}],skipped:[]}};
it('correlates diagnostic stages without treating progress as a successful result',async()=>{
  const {app,sessionId}=await setup();
  const pending=app.inject({method:'POST',url:'/v1/request',headers,payload:{sessionId,request}});
  // Dispatch follows durable audit fsync; wait for the actual condition rather
  // than assuming the disk completes within 35ms under full-suite load.
  await vi.waitFor(async()=>{expect((await app.inject({url:'/v1/audit/status',headers})).json().connectionDiagnostics).toHaveLength(1);},{timeout:2000,interval:10});
  await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload:{type:'progress',requestId:'unknown',stage:'received'}});
  await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload:{type:'progress',requestId:'write',stage:'received'}});
  const status=(await app.inject({url:'/v1/audit/status',headers})).json();expect(status.connectionDiagnostics).toHaveLength(1);expect(status.connectionDiagnostics[0].stages).toHaveLength(1);
  await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload:complete});expect((await pending).json().ok).toBe(true);
});
it('persists local confirmation final results even when no remote request is waiting',async()=>{
  const {app,audit,sessionId}=await setup();
  const pending=app.inject({method:'POST',url:'/v1/request',headers,payload:{sessionId,request}});
  await vi.waitFor(async()=>{expect((await app.inject({url:'/v1/audit/status',headers})).json().connectionDiagnostics).toHaveLength(1);},{timeout:2000,interval:10});
  expect((await app.inject({url:`/v1/poll/${sessionId}`,headers})).json().requests).toHaveLength(1);
  const send=(payload:unknown)=>app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload});
  await send({type:'result',requestId:'write',ok:false,error:{code:'CONFIRMATION_REQUIRED',message:'Confirm locally'}});await pending;
  expect(audit.status().recent.at(-1)?.state).toBe('waiting_confirmation');await send(complete);
  expect(audit.status().recent.at(-1)).toMatchObject({state:'complete',backupIds:['copy']});
  const status=(await app.inject({url:'/v1/audit/status',headers})).json();expect(status.enabled).toBe(true);expect(status.healthy).toBe(true);
});
it('blocks dispatch if the start record cannot be persisted',async()=>{
  const {app,audit,sessionId}=await setup();vi.spyOn(audit,'start').mockRejectedValue(Error('disk unavailable'));
  const r=await app.inject({method:'POST',url:'/v1/request',headers,payload:{sessionId,request}});expect(r.statusCode).toBe(503);
  expect((await app.inject({url:`/v1/poll/${sessionId}`,headers})).json().requests).toEqual([]);
});
it('preserves actual successful writes when final logging fails and returns an explicit warning',async()=>{
  const {app,audit,sessionId}=await setup();vi.spyOn(audit,'result').mockRejectedValue(Error('disk full'));
  const pending=app.inject({method:'POST',url:'/v1/request',headers,payload:{sessionId,request}});
  await vi.waitFor(async()=>{expect((await app.inject({url:'/v1/audit/status',headers})).json().connectionDiagnostics).toHaveLength(1);},{timeout:2000,interval:10});
  await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload:complete});
  expect((await pending).json()).toMatchObject({ok:true,auditWarning:'AUDIT_WRITE_FAILED',data:{complete:true}});
  expect((await app.inject({url:'/v1/audit/status',headers})).json().healthy).toBe(false);
});
it('rejects a mismatched successful result without resolving or caching it',async()=>{
  const {app,audit,sessionId}=await setup();
  const pending=app.inject({method:'POST',url:'/v1/request',headers,payload:{sessionId,request}});
  await vi.waitFor(async()=>{expect((await app.inject({url:'/v1/audit/status',headers})).json().connectionDiagnostics).toHaveLength(1);},{timeout:2000,interval:10});
  const bad={...complete,data:{...complete.data,context:{...context,instanceId:'wrong-runtime'}}};
  const rejected=await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload:bad});expect(rejected.statusCode).toBe(400);
  expect(audit.status().recent.at(-1)?.state).toBe('started');
  await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload:complete});expect((await pending).json()).toMatchObject({ok:true,data:{context}});
});
it('preserves pending native export status through the Bridge preview endpoint',async()=>{
 const {app,sessionId}=await setup();const pending=app.inject({method:'POST',url:'/v1/preview',headers,payload:{sessionId,params:{nodeId:'frame',maxSize:512}}});let previewRequest:any;
 await vi.waitFor(async()=>{const rows=(await app.inject({url:`/v1/poll/${sessionId}`,headers})).json().requests;if(rows.length)previewRequest=rows[0];expect(previewRequest?.method).toBe('export_preview');},{timeout:2000,interval:10});
 await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers,payload:{type:'result',requestId:previewRequest.requestId,ok:false,error:{code:'EXECUTION_FAILED',message:'PREVIEW_PENDING'}}});const result=await pending;expect(result.statusCode).toBe(504);expect(result.json()).toEqual({code:'PREVIEW_PENDING'});
});
