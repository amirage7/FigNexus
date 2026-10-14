import {expect,it,vi} from 'vitest';
import {fixture} from './figma-fixture';
import {createExecutor} from '../apps/figma-plugin/src/executor';

async function setup(){
  const f=fixture(),parent=f.make('FRAME'),node=f.make('RECTANGLE');parent.appendChild(node);node.resize(8,9);node.x=5;node.y=7;
  let allowed=true;const execute=createExecutor(f.api,()=>allowed);
  const edited:any=await execute('execute',{operations:[{op:'update',target:node.id,patch:{width:20}}]});
  return {...f,parent,node,execute,edited,revoke:()=>{allowed=false;}};
}
it('lists persistent backup metadata and restores as a new copy without changing the original or backup',async()=>{
  const f=await setup();expect(f.edited.complete).toBe(true);
  const fresh=createExecutor(f.api,()=>true);
  const list:any=await fresh('list_backups' as any,{});
  expect(list.backups).toHaveLength(1);expect(list.backups[0]).toMatchObject({nodeId:f.node.id,parentId:f.parent.id,pageId:'p',version:1});
  const backupId=list.backups[0].backupId;
  const restored:any=await fresh('restore_backup' as any,{backupId,parentId:f.parent.id,index:0});
  expect(restored.complete).toBe(true);expect(restored.created).toHaveLength(1);
  const copy=f.nodes.get(restored.created[0].id);expect(copy.id).not.toBe(f.node.id);expect(copy.width).toBe(8);expect(copy.height).toBe(9);expect(copy.parent).toBe(f.parent);
  expect(f.node.width).toBe(20);expect(f.nodes.has(backupId)).toBe(true);expect(f.parent.children[0]).toBe(copy);
  expect((await fresh('list_backups' as any,{}) as any).backups).toHaveLength(1);
});
it('refuses ordinary or legacy nodes as backups and refuses backup containers as restore parents',async()=>{
  const f=await setup();
  await expect(f.execute('restore_backup' as any,{backupId:f.node.id,parentId:f.parent.id})).rejects.toThrow('INVALID_BACKUP');
  const backup=f.nodes.get(f.edited.backups[0].backupId);
  await expect(f.execute('restore_backup' as any,{backupId:backup.id,parentId:backup.parent.id})).rejects.toThrow();
});
it.each(['revoke','page','locked'])('rechecks %s after asynchronous backup/parent lookups',async(kind:string)=>{
  const f=await setup(),original=f.api.getNodeByIdAsync,before=f.nodes.size;
  f.api.getNodeByIdAsync=async(id:string)=>{const n=await original(id);if(id===f.parent.id){if(kind==='revoke')f.revoke();if(kind==='page')f.api.currentPage={...f.page,id:'other'};if(kind==='locked')f.parent.locked=true;}return n;};
  await expect(f.execute('restore_backup' as any,{backupId:f.edited.backups[0].backupId,parentId:f.parent.id})).rejects.toThrow(kind==='revoke'?'WRITE_DISABLED':kind==='page'?'PAGE_CHANGED':'PARENT_NOT_EDITABLE');
  expect(f.nodes.size).toBe(before);
});
it('cleans up an unreturned clone if insertion fails',async()=>{
  const f=await setup(),before=f.nodes.size;f.parent.insertChild=vi.fn(()=>{throw Error('insertion failed');});
  const r:any=await f.execute('restore_backup' as any,{backupId:f.edited.backups[0].backupId,parentId:f.parent.id});
  expect(r.complete).toBe(false);expect(r.created).toEqual([]);expect(f.nodes.size).toBe(before);
});
it('paginates backups and rejects out-of-range restore indexes without mutation',async()=>{
  const f=await setup();await f.execute('execute',{operations:[{op:'update',target:f.node.id,patch:{height:30}}]});
  const a:any=await f.execute('list_backups' as any,{limit:1});expect(a.backups).toHaveLength(1);expect(a.nextCursor).toBe(1);
  const b:any=await f.execute('list_backups' as any,{limit:1,cursor:a.nextCursor});expect(b.backups).toHaveLength(1);expect(b.nextCursor).toBe(null);
  const before=f.nodes.size;await expect(f.execute('restore_backup' as any,{backupId:a.backups[0].backupId,parentId:f.parent.id,index:999})).rejects.toThrow('INDEX_OUT_OF_RANGE');expect(f.nodes.size).toBe(before);
});
it('rejects tampered metadata and oversized backup subtrees before cloning',async()=>{
  const f=await setup(),backup=f.nodes.get(f.edited.backups[0].backupId),before=f.nodes.size;
  backup.setPluginData('ai-bridge-backup-v1',JSON.stringify({version:1,backupId:backup.id,nodeId:'source',parentId:'p',pageId:'wrong',index:0,createdAt:new Date().toISOString()}));
  await expect(f.execute('restore_backup' as any,{backupId:backup.id,parentId:f.parent.id})).rejects.toThrow('INVALID_BACKUP');expect(f.nodes.size).toBe(before);
  const frame=f.make('FRAME');for(let i=0;i<500;i++)frame.appendChild(f.make('RECTANGLE'));
  const edited:any=await f.execute('execute',{operations:[{op:'update',target:frame.id,patch:{name:'too large'}}]});expect(edited.complete).toBe(false);expect(edited.failed.message).toBe('BACKUP_TOO_LARGE');
});
it('bounds backup catalog scanning even when unrelated nodes dominate the page',async()=>{
  const f=fixture();for(let i=0;i<10001;i++)f.make('RECTANGLE');const execute=createExecutor(f.api,()=>true);
  const r:any=await execute('list_backups',{});expect(r.scanned).toBe(10000);expect(r.truncated).toBe(true);expect(r.backups).toEqual([]);
});
