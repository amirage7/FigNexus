import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './figma-fixture';
import {reduceDeleteState} from '../apps/figma-plugin/src/confirmation-ui';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });
it('retains restore write IDs after result cache eviction and refuses a second clone',async()=>{
  const f=fixture(),sent:any[]=[];f.api.showUI=vi.fn();f.api.on=vi.fn();f.api.ui={postMessage:(m:any)=>sent.push(m)};
  vi.stubGlobal('figma',f.api);vi.stubGlobal('__html__','test');await import('../apps/figma-plugin/src/main');f.api.ui.onmessage({type:'set-write',enabled:true});
  const node=f.make('RECTANGLE');f.api.ui.onmessage({type:'request',requestId:'backup-create',method:'execute',params:{operations:[{op:'update',target:node.id,patch:{width:40}}]}});await new Promise(r=>setTimeout(r,0));
  const backupId=sent.at(-1).data.backups[0].backupId;
  const request={type:'request',requestId:'restore-id',method:'restore_backup',params:{backupId,parentId:'p'}};
  f.api.ui.onmessage(request);await new Promise(r=>setTimeout(r,0));expect(sent.at(-1).data.complete).toBe(true);const size=f.nodes.size;
  f.api.ui.onmessage(request);await new Promise(r=>setTimeout(r,0));expect(f.nodes.size).toBe(size);
  for(let i=0;i<129;i++)f.api.ui.onmessage({type:'request',requestId:`restore-ping-${i}`,method:'ping'});await new Promise(r=>setTimeout(r,0));
  f.api.ui.onmessage(request);await new Promise(r=>setTimeout(r,0));expect(sent.at(-1)).toMatchObject({ok:false,error:{code:'WRITE_RESULT_EXPIRED'}});expect(f.nodes.size).toBe(size);
});
async function deletionFixture(multi=false) {
  const f=fixture(),node=f.make('RECTANGLE'),other=multi?f.make('RECTANGLE'):undefined,sent:any[]=[];
  f.api.showUI=vi.fn();f.api.on=vi.fn();f.api.ui={postMessage:(m:unknown)=>sent.push(m)};
  vi.stubGlobal('figma',f.api);vi.stubGlobal('__html__','test');await import('../apps/figma-plugin/src/main');
  f.api.ui.onmessage({type:'set-write',enabled:true});
  const request={type:'request',requestId:'local-delete',method:'execute',params:{operations:[{op:'delete',target:node.id},...(other?[{op:'delete',target:other.id}]:[])]}};
  f.api.ui.onmessage(request);await new Promise(r=>setTimeout(r,0));
  const grant=sent.find(m=>m.type==='confirmation');
  const confirm=(approved=true,confirmationId=grant.confirmationId)=>f.api.ui.onmessage({type:'confirm-delete',requestId:request.requestId,confirmationId,approved});
  return {...f,node,other,sent,request,grant,confirm};
}
it('executes on local confirmation and returns the same cached result after expiry',async()=>{
  const f=await deletionFixture();
  f.confirm();f.confirm();await new Promise(r=>setTimeout(r,0));
  expect(f.node.removed).toBe(true);expect(f.api.commitUndo).toHaveBeenCalledTimes(1);
  expect(f.sent.some(m=>m.type==='confirmation_state'&&m.state==='accepted')).toBe(true);
  const result=f.sent.filter(m=>m.type==='result'&&m.ok).at(-1);expect(result.data.backups).toHaveLength(1);
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+600000);
  f.api.ui.onmessage(f.request);await new Promise(r=>setTimeout(r,0));
  expect(f.sent.at(-1)).toEqual(result);expect(f.api.commitUndo).toHaveBeenCalledTimes(1);
});
it.each(['expired','revoked','page','stale','cancelled'])('acknowledges %s confirmation without deleting',async(reason:string)=>{
  const f=await deletionFixture();
  if(reason==='expired')vi.spyOn(Date,'now').mockReturnValue(Date.now()+300001);
  if(reason==='revoked')f.api.ui.onmessage({type:'set-write',enabled:false});
  if(reason==='page')f.api.currentPage={...f.page,id:'different-page'};
  f.confirm(reason!=='cancelled',reason==='stale'?'stale-id':f.grant.confirmationId);
  await new Promise(r=>setTimeout(r,0));
  expect(f.node.removed).toBe(false);expect(f.api.commitUndo).not.toHaveBeenCalled();
  expect(f.sent.at(-1)).toMatchObject({type:'confirmation_state',state:reason==='cancelled'?'cancelled':'invalid'});
});
it('rechecks write permission before executing a locally confirmed queued request',async()=>{
  const f=await deletionFixture();f.confirm();f.api.ui.onmessage({type:'set-write',enabled:false});
  await new Promise(r=>setTimeout(r,0));
  expect(f.node.removed).toBe(false);expect(f.api.commitUndo).not.toHaveBeenCalled();
  expect(f.sent.at(-1)).toMatchObject({type:'confirmation_state',state:'invalid'});
});
it.each(['page','expiry'])('rechecks %s before the locally confirmed queue runs',async(reason:string)=>{
  const f=await deletionFixture();f.confirm();
  if(reason==='page')f.api.currentPage={...f.page,id:'changed-page'};
  else vi.spyOn(Date,'now').mockReturnValue(Date.now()+300001);
  await new Promise(r=>setTimeout(r,0));
  expect(f.node.removed).toBe(false);expect(f.api.commitUndo).not.toHaveBeenCalled();
  expect(f.sent.at(-1)).toMatchObject({type:'confirmation_state',state:'invalid'});
});
it('protects pending deletion IDs against a different non-delete request',async()=>{
  const f=await deletionFixture();
  f.api.ui.onmessage({...f.request,params:{operations:[{op:'update',target:f.node.id,patch:{name:'wrong-payload'}}]}});
  await new Promise(r=>setTimeout(r,0));
  expect(f.sent.at(-1)).toMatchObject({ok:false,error:{code:'IDEMPOTENCY_CONFLICT'}});
  expect(f.node.name).not.toBe('wrong-payload');
  f.confirm();await new Promise(r=>setTimeout(r,0));expect(f.node.removed).toBe(true);
});
it('does not report cancellation after an accepted execution has started',async()=>{
  const f=await deletionFixture();const original=f.api.getNodeByIdAsync;
  let release!:()=>void;
  f.api.getNodeByIdAsync=async(id:string)=>{await new Promise<void>(resolve=>{release=resolve;});return original(id);};
  f.confirm();await new Promise(r=>setTimeout(r,0));f.confirm(false);
  expect(f.sent.at(-1)).toMatchObject({type:'confirmation_state',state:'accepted'});
  release();await new Promise(r=>setTimeout(r,0));
  expect(f.node.removed).toBe(true);expect(f.sent.at(-1).ok).toBe(true);
});
it('preserves partial execution status when revoked permission rejects a later click',async()=>{
  const f=await deletionFixture(true);const original=f.api.getNodeByIdAsync;let release!:()=>void;
  f.api.getNodeByIdAsync=async(id:string)=>{if(id===f.other!.id)await new Promise<void>(resolve=>{release=resolve;});return original(id);};
  f.confirm();await new Promise(r=>setTimeout(r,0));expect(f.node.removed).toBe(true);
  f.api.ui.onmessage({type:'set-write',enabled:false});f.confirm(false);
  expect(f.sent.at(-1)).toMatchObject({type:'confirmation_state',state:'accepted'});
  release();await new Promise(r=>setTimeout(r,0));
  expect(f.other!.removed).toBe(false);expect(f.sent.at(-1).data.complete).toBe(false);expect(f.sent.at(-1).data.backups).toHaveLength(1);
  const state=f.sent.filter(m=>['confirmation','confirmation_state','result'].includes(m.type)).reduce(reduceDeleteState,{notice:''});
  expect(state.notice).toContain('未全部完成');
});
it('tracks an approved retry queued ahead of the local confirmation callback',async()=>{
  const f=await deletionFixture(true);const original=f.api.getNodeByIdAsync;let release!:()=>void;
  f.api.getNodeByIdAsync=async(id:string)=>{if(id===f.other!.id)await new Promise<void>(resolve=>{release=resolve;});return original(id);};
  f.api.ui.onmessage(f.request);f.confirm();await new Promise(r=>setTimeout(r,0));
  expect(f.node.removed).toBe(true);f.api.ui.onmessage({type:'set-write',enabled:false});f.confirm(false);
  expect(f.sent.at(-1)).toMatchObject({type:'confirmation_state',state:'accepted'});
  release();await new Promise(r=>setTimeout(r,0));
  const state=f.sent.filter(m=>['confirmation','confirmation_state','result'].includes(m.type)).reduce(reduceDeleteState,{notice:''});
  expect(state.notice).toContain('未全部完成');expect(f.other!.removed).toBe(false);
});
it('main thread reads current context and rejects arbitrary operations', async () => {
  const sent: any[] = [];
  const fake: any = { root: { id: '0:0', name: 'Design' }, currentPage: { id: '0:1', name: 'Page' }, showUI: vi.fn(), ui: { postMessage: (m: unknown) => sent.push(m) }, on: vi.fn() };
  vi.stubGlobal('figma', fake); vi.stubGlobal('__html__', 'test');
  await import('../apps/figma-plugin/src/main');
  fake.ui.onmessage({ type: 'request', requestId: 'x', method: 'eval', code: 'figma.createFrame()' });
  expect(sent).toHaveLength(0);
  fake.ui.onmessage({ type: 'request', requestId: 'r', method: 'ping' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const result=sent.find(m=>m.type==='result');
  expect(result.data.context.page).toEqual(fake.currentPage);
  expect(result.requestId).toBe('r');
});
it('rejects a stale confirmation after expiration and request ID reuse',async()=>{
  const f=fixture(),first=f.make('TEXT'),other=f.make('TEXT'),sent:any[]=[];
  f.api.showUI=vi.fn();f.api.on=vi.fn();f.api.ui={postMessage:(m:unknown)=>sent.push(m)};
  let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  vi.stubGlobal('figma',f.api);vi.stubGlobal('__html__','test');await import('../apps/figma-plugin/src/main');
  f.api.ui.onmessage({type:'set-write',enabled:true});
  const p={type:'request',requestId:'reused-delete',method:'execute',params:{operations:[{op:'delete',target:first.id}]}};
  const settle=()=>new Promise(r=>setTimeout(r,0));
  f.api.ui.onmessage(p);await settle();const old=sent.filter(m=>m.type==='confirmation').at(-1);
  now+=300001;
  const next={...p,params:{operations:[{op:'delete',target:other.id}]}};
  f.api.ui.onmessage(next);await settle();const fresh=sent.filter(m=>m.type==='confirmation').at(-1);
  expect(fresh.confirmationId).not.toBe(old.confirmationId);
  f.api.ui.onmessage({type:'confirm-delete',requestId:p.requestId,confirmationId:old.confirmationId,approved:true});
  f.api.ui.onmessage(next);await settle();expect(sent.at(-1).error.code).toBe('CONFIRMATION_REQUIRED');expect(other.removed).toBe(false);
  f.api.ui.onmessage({type:'confirm-delete',requestId:p.requestId,confirmationId:fresh.confirmationId,approved:true});
  f.api.ui.onmessage(next);await settle();expect(other.removed).toBe(true);expect(first.removed).toBe(false);
});
it('never re-executes an evicted write ID during the plugin run', async () => {
  const sent: any[] = [];
  const fake: any = { root: { id: '0:0', name: 'Design' }, currentPage: { id: '0:1', name: 'Page' }, showUI: vi.fn(), ui: { postMessage: (m: unknown) => sent.push(m) }, on: vi.fn() };
  vi.stubGlobal('figma', fake); vi.stubGlobal('__html__', 'test'); await import('../apps/figma-plugin/src/main');
  const write = { type: 'request', requestId: 'write', method: 'execute', params: { operations: [{ op: 'create', type: 'FRAME' }] } };
  fake.ui.onmessage(write); await new Promise(r => setTimeout(r, 0));
  for (let i = 0; i < 129; i++) fake.ui.onmessage({ type: 'request', requestId: `ping-${i}`, method: 'ping' });
  await new Promise(r => setTimeout(r, 0));
  fake.ui.onmessage(write); await new Promise(r => setTimeout(r, 0));
  expect(sent.at(-1).error.code).toBe('WRITE_RESULT_EXPIRED');
  fake.ui.onmessage({ ...write, params: { operations: [{ op: 'create', type: 'ELLIPSE' }] } });
  await new Promise(r => setTimeout(r, 0)); expect(sent.at(-1).error.code).toBe('IDEMPOTENCY_CONFLICT');
});
it('requires local confirmation bound to the exact delete payload',async()=>{
  const f=fixture(),first=f.make('TEXT'),other=f.make('TEXT'),sent:any[]=[];
  f.api.showUI=vi.fn();f.api.on=vi.fn();f.api.ui={postMessage:(m:unknown)=>sent.push(m)};
  vi.stubGlobal('figma',f.api);vi.stubGlobal('__html__','test');await import('../apps/figma-plugin/src/main');
  f.api.ui.onmessage({type:'set-write',enabled:true});
  const p={type:'request',requestId:'delete-batch',method:'execute',params:{operations:[{op:'delete',target:first.id}]}};
  const settle=()=>new Promise(r=>setTimeout(r,0));
  f.api.ui.onmessage(p);await settle();expect(sent.at(-1).error.code).toBe('CONFIRMATION_REQUIRED');expect(first.removed).toBe(false);
  f.api.ui.onmessage({type:'confirm-delete',requestId:p.requestId,confirmationId:'stale-confirmation',approved:true});
  f.api.ui.onmessage(p);await settle();expect(sent.at(-1).error.code).toBe('CONFIRMATION_REQUIRED');expect(first.removed).toBe(false);
  f.api.ui.onmessage({type:'confirm-delete',requestId:p.requestId,confirmationId:sent.filter(m=>m.type==='confirmation').at(-1).confirmationId,approved:true});
  f.api.ui.onmessage({...p,params:{operations:[{op:'delete',target:other.id}]}});await settle();expect(sent.at(-1).error.code).toBe('IDEMPOTENCY_CONFLICT');expect(other.removed).toBe(false);
  f.api.ui.onmessage(p);await settle();f.api.ui.onmessage({type:'confirm-delete',requestId:p.requestId,confirmationId:sent.filter(m=>m.type==='confirmation').at(-1).confirmationId,approved:true});f.api.ui.onmessage(p);await settle();
  expect(first.removed).toBe(true);expect(other.removed).toBe(false);expect(sent.at(-1).data.backups).toHaveLength(1);
});
it('listens to current-page node changes without subscribing to global dynamic-page documentchange',async()=>{
 const f=fixture(),callbacks=new Map<string,Function>();f.api.showUI=vi.fn();f.api.ui={postMessage:vi.fn()};f.api.on=vi.fn((name:string,fn:Function)=>{if(name==='documentchange')throw Error('loadAllPagesAsync required');callbacks.set(name,fn);});f.page.on=vi.fn();f.page.off=vi.fn();vi.stubGlobal('figma',f.api);vi.stubGlobal('__html__','test');await expect(import('../apps/figma-plugin/src/main')).resolves.toBeDefined();expect(f.page.on).toHaveBeenCalledWith('nodechange',expect.any(Function));const next={...f.page,id:'new',on:vi.fn(),off:vi.fn()};f.api.currentPage=next;callbacks.get('currentpagechange')!();expect(f.page.off).toHaveBeenCalledWith('nodechange',expect.any(Function));expect(next.on).toHaveBeenCalledWith('nodechange',expect.any(Function));
});
