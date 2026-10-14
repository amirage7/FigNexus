import { it, expect, vi } from 'vitest';
import { createExecutor } from '../apps/figma-plugin/src/executor';
import { fixture } from './figma-fixture';
it('edits existing text with fonts and native backup while preserving ID', async()=>{
  const f=fixture(), text=f.make('TEXT'); text.characters='old'; const e=createExecutor(f.api,()=>true);
  const r:any=await e('execute',{operations:[{op:'update',target:text.id,patch:{characters:'new',fontSize:24}}]});
  expect(r.complete).toBe(true); expect(text.characters).toBe('new'); expect(f.api.loadFontAsync).toHaveBeenCalledTimes(2);
  expect(f.nodes.get(r.backups[0].backupId).characters).toBe('old'); expect(r.backups[0].nodeId).toBe(text.id);
});
it('clones, reparents and reorders with sequential refs',async()=>{
  const f=fixture(), frame=f.make('FRAME'), shape=f.make('RECTANGLE'); const e=createExecutor(f.api,()=>true);
  const r:any=await e('execute',{operations:[{op:'clone',target:shape.id,ref:'copy'},{op:'reparent',target:'$copy',parent:frame.id},{op:'reorder',target:'$copy',index:0}]});
  expect(r.complete).toBe(true); expect(frame.children[0].id).toBe(r.refs.copy); expect(shape.parent).toBe(f.page);
});
it('refuses deleting until locally approved and keeps a native backup',async()=>{
  const f=fixture(), text=f.make('TEXT'); const batch={operations:[{op:'delete',target:text.id}]};
  await expect(createExecutor(f.api,()=>true)('execute',batch)).rejects.toThrow('CONFIRMATION_REQUIRED'); expect(text.removed).toBe(false);
  const r:any=await createExecutor(f.api,()=>true,undefined,()=>true)('execute',batch); expect(text.removed).toBe(true); expect(f.nodes.has(r.backups[0].backupId)).toBe(true);
});
it('reports partial completion and refuses invalid properties without mutation',async()=>{
  const f=fixture(), shape=f.make('RECTANGLE'); const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'update',target:shape.id,patch:{name:'changed'}},{op:'update',target:shape.id,patch:{characters:'invalid'}},{op:'create',type:'ELLIPSE'}]});
  expect(r.complete).toBe(false); expect(r.completed).toEqual([0]); expect(r.failed.index).toBe(1); expect(r.skipped).toEqual([2]); expect(shape.name).toBe('changed');
});

