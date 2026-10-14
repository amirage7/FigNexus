import { it, expect, vi } from 'vitest';
import { fixture } from './figma-fixture';
import { createExecutor } from '../apps/figma-plugin/src/executor';
import { PreviewManager } from '../apps/figma-plugin/src/preview';
it('rejoins a stalled native export and consumes a late PNG once',async()=>{
  vi.useFakeTimers();const f=fixture(),frame=f.make('FRAME'),stages:string[]=[];
  let finish!:(bytes:Uint8Array)=>void;
  frame.exportAsync=vi.fn(()=>new Promise<Uint8Array>(r=>{finish=r;}));
  f.api.base64Encode=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
  const manager=new PreviewManager(f.api,s=>stages.push(s),10);
  const request={nodeId:frame.id,maxSize:256};
  try{
    const rejected=manager.export(request).then(()=>'',e=>e.message);
    await vi.advanceTimersByTimeAsync(11);expect(await rejected).toBe('PREVIEW_PENDING');
    const retry=manager.export(request);await Promise.resolve();expect(frame.exportAsync).toHaveBeenCalledTimes(1);
    finish(new Uint8Array([1,2]));const meta=await retry;
    expect(manager.chunk({exportId:meta.exportId,index:0}).base64).toBe('AQI=');
    frame.exportAsync.mockResolvedValue(new Uint8Array([3]));await manager.export(request);
    expect(frame.exportAsync).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
});
it('retains a PNG completed without a waiting request without late progress',async()=>{
  vi.useFakeTimers();const f=fixture(),frame=f.make('FRAME'),stages:string[]=[];
  let finish!:(bytes:Uint8Array)=>void;frame.exportAsync=vi.fn(()=>new Promise<Uint8Array>(r=>{finish=r;}));
  const manager=new PreviewManager(f.api,s=>stages.push(s),10),request={nodeId:frame.id,maxSize:256};
  try{
    const rejected=manager.export(request).then(()=>'',e=>e.message);await vi.advanceTimersByTimeAsync(11);expect(await rejected).toBe('PREVIEW_PENDING');
    await expect(manager.export({...request,maxSize:512})).rejects.toThrow('PREVIEW_NATIVE_BUSY');
    finish(new Uint8Array([1]));await vi.advanceTimersByTimeAsync(1);
    expect(stages).toEqual(['node-loading','node-ready','export-loading']);
    expect((await manager.export(request)).totalBytes).toBe(1);expect(frame.exportAsync).toHaveBeenCalledTimes(1);
  }finally{vi.useRealTimers();}
});
it.each(['page','edit'] as const)('discards late PNGs invalidated by %s without starting a second pending native job',async(kind)=>{
  vi.useFakeTimers();const f=fixture(),frame=f.make('FRAME');let finish!:(bytes:Uint8Array)=>void;
  frame.exportAsync=vi.fn(()=>new Promise<Uint8Array>(r=>{finish=r;}));
  const manager=new PreviewManager(f.api,()=>{},10),request={nodeId:frame.id,maxSize:256};
  try{
    const rejected=manager.export(request).then(()=>'',e=>e.message);await vi.advanceTimersByTimeAsync(11);expect(await rejected).toBe('PREVIEW_PENDING');
    if(kind==='page')f.api.currentPage={id:'other'};else manager.invalidate();
    await expect(manager.export(request)).rejects.toThrow('PREVIEW_NATIVE_BUSY');expect(frame.exportAsync).toHaveBeenCalledTimes(1);
    finish(new Uint8Array([1]));await vi.advanceTimersByTimeAsync(1);
    f.api.currentPage=f.page;frame.exportAsync.mockResolvedValue(new Uint8Array([2,3]));
    expect((await manager.export(request)).totalBytes).toBe(2);expect(frame.exportAsync).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
});
it('expires a retained late PNG after five minutes',async()=>{
  vi.useFakeTimers();const f=fixture(),frame=f.make('FRAME');let finish!:(bytes:Uint8Array)=>void;
  frame.exportAsync=vi.fn(()=>new Promise<Uint8Array>(r=>{finish=r;}));const manager=new PreviewManager(f.api,()=>{},10),request={nodeId:frame.id,maxSize:256};
  try{
    const rejected=manager.export(request).then(()=>'',e=>e.message);await vi.advanceTimersByTimeAsync(11);expect(await rejected).toBe('PREVIEW_PENDING');
    finish(new Uint8Array([1]));await vi.advanceTimersByTimeAsync(300001);
    frame.exportAsync.mockResolvedValue(new Uint8Array([2,3]));expect((await manager.export(request)).totalBytes).toBe(2);
    expect(frame.exportAsync).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
});
it('bounds retained PNG chunks to two exports and invalidates chunks on edits',async()=>{
  const f=fixture(),frame=f.make('FRAME');frame.exportAsync=async()=>new Uint8Array([1]);
  f.api.base64Encode=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
  const manager=new PreviewManager(f.api),request={nodeId:frame.id,maxSize:256};
  const first=await manager.export(request),second=await manager.export(request),third=await manager.export(request);
  expect(()=>manager.chunk({exportId:first.exportId,index:0})).toThrow('PREVIEW_EXPIRED');
  expect(manager.chunk({exportId:second.exportId,index:0}).base64).toBe('AQ==');
  manager.invalidate();expect(()=>manager.chunk({exportId:third.exportId,index:0})).toThrow('PREVIEW_EXPIRED');
});
it('rejoins a pending node lookup without starting a second lookup',async()=>{
  vi.useFakeTimers();const f=fixture(),frame=f.make('FRAME');let finish!:(node:any)=>void;
  f.api.getNodeByIdAsync=vi.fn(()=>new Promise<any>(r=>{finish=r;}));frame.exportAsync=async()=>new Uint8Array([1]);
  const manager=new PreviewManager(f.api,()=>{},10),request={nodeId:frame.id,maxSize:256};
  try{
    const rejected=manager.export(request).then(()=>'',e=>e.message);await vi.advanceTimersByTimeAsync(11);expect(await rejected).toBe('PREVIEW_PENDING');
    const retry=manager.export(request);finish(frame);expect((await retry).totalBytes).toBe(1);
    expect(f.api.getNodeByIdAsync).toHaveBeenCalledTimes(1);
  }finally{vi.useRealTimers();}
});
it('sets bounded native Auto Layout and keeps a backup', async()=>{
  const f=fixture(), frame=f.make('FRAME');
  const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'layout',target:frame.id,layout:{direction:'VERTICAL',gap:12,padding:20,primarySizing:'FIXED',counterSizing:'FIXED'}}]});
  expect(r.complete).toBe(true); expect(frame.layoutMode).toBe('VERTICAL'); expect(frame.paddingLeft).toBe(20); expect(frame.itemSpacing).toBe(12); expect(r.backups).toHaveLength(1);
});
it.each(['HORIZONTAL','VERTICAL'] as const)('preserves existing fixed dimensions when enabling %s layout', async(direction: 'HORIZONTAL' | 'VERTICAL')=>{
  const f=fixture(), frame=f.make('FRAME'); frame.resize(342,144);
  // Figma reflows a newly enabled layout before sizing-mode setters run.
  let mode='NONE';
  Object.defineProperty(frame,'layoutMode',{configurable:true,get:()=>mode,set:(value)=>{mode=value;frame.resize(219,92);}});
  const result:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'layout',target:frame.id,layout:{direction,padding:20,primarySizing:'FIXED',counterSizing:'FIXED'}}]});
  expect(result.complete).toBe(true);expect(frame.width).toBe(342);expect(frame.height).toBe(144);
});
it.each(['HORIZONTAL','VERTICAL'] as const)('preserves only the fixed primary axis in %s layout', async(direction: 'HORIZONTAL' | 'VERTICAL')=>{
  const f=fixture(), frame=f.make('FRAME'); frame.resize(342,144);
  let mode='NONE';
  Object.defineProperty(frame,'layoutMode',{configurable:true,get:()=>mode,set:(value)=>{mode=value;frame.resize(219,92);}});
  const result:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'layout',target:frame.id,layout:{direction,primarySizing:'FIXED',counterSizing:'AUTO'}}]});
  expect(result.complete).toBe(true);expect(frame.width).toBe(direction==='HORIZONTAL'?342:219);expect(frame.height).toBe(direction==='VERTICAL'?144:92);expect(frame.primaryAxisSizingMode).toBe('FIXED');expect(frame.counterAxisSizingMode).toBe('AUTO');
});
it('bounds PNG resolution and chunks and rejects oversized export',async()=>{
  const f=fixture(), frame=f.make('FRAME'); frame.width=4000;frame.height=8000;
  frame.exportAsync=vi.fn(async()=>new Uint8Array(100000)); f.api.base64Encode=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
  const previews=new PreviewManager(f.api);
  const meta=await previews.export({nodeId:frame.id,maxSize:2048});
  expect(frame.exportAsync.mock.calls[0][0].constraint.value).toBe(.256); expect(meta.chunks).toBe(3);
  expect(previews.chunk({exportId:meta.exportId,index:0}).base64).toHaveLength(48000);
  expect(()=>previews.chunk({exportId:meta.exportId,index:3})).toThrow('CHUNK_OUT_OF_RANGE');
  frame.exportAsync.mockResolvedValue(new Uint8Array(2097153)); await expect(previews.export({nodeId:frame.id,maxSize:2048})).rejects.toThrow('PREVIEW_TOO_LARGE');
});
it('rejects exports of other-page nodes and non-frames',async()=>{
  const f=fixture(), text=f.make('TEXT'), frame=f.make('FRAME'); const previews=new PreviewManager(f.api);
  await expect(previews.export({nodeId:text.id,maxSize:512})).rejects.toThrow('FRAME_REQUIRED');
  frame.parent=null; await expect(previews.export({nodeId:frame.id,maxSize:512})).rejects.toThrow('FRAME_REQUIRED');
});

it('invalidates an already exported preview before a later bridge edit',async()=>{
 const f=fixture(),frame=f.make('FRAME');frame.exportAsync=vi.fn(async()=>new Uint8Array([1,2,3]));f.api.base64Encode=(b:Uint8Array)=>Buffer.from(b).toString('base64');const execute=createExecutor(f.api,()=>true);const exported:any=await execute('export_preview',{nodeId:frame.id,maxSize:256});await execute('execute',{operations:[{op:'update',target:frame.id,patch:{width:120}}]});await expect(execute('preview_chunk',{exportId:exported.exportId,index:0})).rejects.toThrow('PREVIEW_EXPIRED');
});
