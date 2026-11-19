import {expect,it,vi} from 'vitest';
import {createExecutor} from '../apps/figma-plugin/src/executor';
import {ExecuteInput,ExecuteResult} from '../packages/protocol/src/index';
import {fixture} from './figma-fixture';

it('removes existing fill and applies a black native border in the same operation', async () => {
 const f = fixture(), node = f.make('RECTANGLE');
 node.fills = [{ type: 'SOLID', color: { r: 0, g: 0.4, b: 0 } }];
 const params = ExecuteInput.parse({ operations: [
  { op: 'update', target: node.id, patch: { fills: [], stroke: { r: 0, g: 0, b: 0 }, strokeWeight: 1 } },
 ] });
 const result = await createExecutor(f.api, () => true)('execute', params);
 expect(result).toMatchObject({ complete: true });
 expect(node.fills).toEqual([]);
 expect(node.strokes).toMatchObject([{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]);
 expect(node.strokeWeight).toBe(1);
});

it('clones full hierarchy, maps repeated names and edits a descendant ref without touching source',async()=>{
 const f=fixture(),frame=f.make('FRAME'),text=f.make('TEXT'),image=f.make('RECTANGLE');
 text.name=image.name='Repeated';text.characters='Original';image.fills=[{type:'IMAGE',imageHash:'native-image',scaleMode:'FILL'}];frame.appendChild(text);frame.appendChild(image);
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[
  {op:'clone',target:frame.id,ref:'copy',name:'Copy',x:900,y:80},
  {op:'update',target:`$copy/${text.id}`,patch:{characters:'Updated'}}
 ]});
 expect(r.status).toBe('complete');expect(r.results[0].idMap[frame.id]).toBe(r.refs.copy);
 expect(f.nodes.get(r.results[0].idMap[text.id]).characters).toBe('Updated');
 expect(f.nodes.get(r.results[0].idMap[image.id]).fills).toEqual(image.fills);
 expect(f.nodes.get(r.refs.copy)).toMatchObject({name:'Copy',x:900,y:80});expect(text.characters).toBe('Original');
 expect(r.backups).toEqual([]);
 expect(ExecuteResult.safeParse(r).success).toBe(true);
});
it('rejects oversized mappings before cloning and keeps a complete source tree',async()=>{
 const f=fixture(),frame=f.make('FRAME');for(let i=0;i<100;i++)frame.appendChild(f.make('RECTANGLE'));
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'clone',target:frame.id}]});
 expect(r.status).toBe('none');expect(r.failed.code).toBe('CLONE_RESULT_TOO_LARGE');expect(f.page.children).toEqual([frame]);
});
it('bounds batch readback under transport limits without discarding IDs or item statuses',async()=>{
 const f=fixture(),ops=Array.from({length:25},()=>({op:'create',type:'TEXT',name:'字'.repeat(512),characters:'字'.repeat(2048)}));
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:ops});
 expect(Buffer.byteLength(JSON.stringify(r),'utf8')).toBeLessThan(60000);expect(r.results).toHaveLength(25);expect(r.created).toHaveLength(25);
 expect(r.results.some((item:any)=>item.node?.charactersTruncated)).toBe(true);
});
it('commits one undo for a mixed create and edit batch and returns per-item readback',async()=>{
 const f=fixture();const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'create',type:'TEXT',ref:'t',characters:'old'},{op:'update',target:'$t',patch:{characters:'new'}}]});
 expect(f.api.commitUndo).toHaveBeenCalledTimes(1);expect(r.results.map((x:any)=>x.status)).toEqual(['completed','completed']);
 expect(r.results[1].node).toMatchObject({characters:'new',parentId:'p',coordinateSpace:'parent'});
});
it('allows explicit self unlock but refuses an ancestor lock with its ID',async()=>{
 const f=fixture(),n=f.make('TEXT');n.locked=true;
 const e=createExecutor(f.api,()=>true);const r:any=await e('execute',{operations:[{op:'update',target:n.id,patch:{locked:false,characters:'unlocked'}}]});
 expect(r.complete).toBe(true);expect(n.locked).toBe(false);
 const parent=f.make('FRAME');parent.appendChild(n);parent.locked=true;
 const blocked:any=await e('execute',{operations:[{op:'update',target:n.id,patch:{locked:false}}]});
 expect(blocked.status).toBe('none');expect(blocked.failed.message).toContain(parent.id);
});
it('reports partial, failed and skipped operations and actual setter side effects',async()=>{
 const f=fixture(),n=f.make('RECTANGLE');let opacity=1;
 Object.defineProperty(n,'opacity',{get:()=>opacity,set:(value)=>{opacity=value;throw Error('NATIVE_SETTER_FAILED');}});
 const r:any=await createExecutor(f.api,()=>true,undefined,()=>true)('execute',{operations:[{op:'update',target:n.id,patch:{opacity:.4}},{op:'delete',target:n.id}]});
 expect(r.status).toBe('partial');expect(r.results[0]).toMatchObject({status:'failed',node:{opacity:.4},mutated:true});expect(r.results[1].status).toBe('skipped');
});
it('fails font loading before creating backups or changing text',async()=>{
 const f=fixture(),n=f.make('TEXT');n.characters='old';f.api.loadFontAsync=vi.fn(async()=>{throw Error('font unavailable');});
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'update',target:n.id,patch:{characters:'new'}}]});
 expect(r.status).toBe('none');expect(r.failed.code).toBe('FONT_LOAD_FAILED');expect(r.failed.message).toContain('Inter');expect(f.page.children).toEqual([n]);
});
it('restores mixed text ranges and extends the last style when text grows',async()=>{
 const f=fixture(),n=f.make('TEXT');n.characters='abcd';n.textAutoResize='HEIGHT';
 n.getStyledTextSegments=()=>[{start:0,end:2,fontSize:12},{start:2,end:4,fontSize:24}];n.setRangeFontSize=vi.fn();
 await createExecutor(f.api,()=>true)('execute',{operations:[{op:'update',target:n.id,patch:{characters:'abcdef'}}]});
 expect(n.setRangeFontSize).toHaveBeenCalledWith(0,2,12);expect(n.setRangeFontSize).toHaveBeenCalledWith(2,6,24);expect(n.textAutoResize).toBe('HEIGHT');
});
it('detects unavailable private data before creating backups',async()=>{
 const f=fixture(),n=f.make('TEXT');n.characters='old';n.getPluginData=()=>{throw Error('Plugin does not have a valid manifest ID');};
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'update',target:n.id,patch:{characters:'new'}}]});
 expect(r.status).toBe('none');expect(r.failed.code).toBe('PLUGIN_DATA_UNAVAILABLE');expect(f.page.children).toEqual([n]);expect(n.characters).toBe('old');
});
it('reports completed deletion and keeps the backup',async()=>{
 const f=fixture(),n=f.make('TEXT');const r:any=await createExecutor(f.api,()=>true,undefined,()=>true)('execute',{operations:[{op:'delete',target:n.id}]});
 expect(r.results[0]).toMatchObject({status:'completed',deletedId:n.id});expect(r.backups).toHaveLength(1);
});
it('reports a created node left behind if native creation and cleanup both fail',async()=>{
 const f=fixture(),create=f.api.createRectangle;
 f.api.createRectangle=()=>{const n=create();n.resize=()=>{throw Error('NATIVE_RESIZE_FAILED');};n.remove=()=>{throw Error('CLEANUP_FAILED');};return n;};
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'create',type:'RECTANGLE'}]});
 expect(r.status).toBe('partial');expect(r.complete).toBe(false);expect(r.results[0].residualIds).toEqual([f.page.children[0].id]);expect(r.results[0].node.id).toBe(f.page.children[0].id);
});
it('preserves creation residual evidence in a mixed batch',async()=>{
 const f=fixture(),create=f.api.createRectangle;
 f.api.createRectangle=()=>{const n=create();n.resize=()=>{throw Error('NATIVE_RESIZE_FAILED');};n.remove=()=>{throw Error('CLEANUP_FAILED');};return n;};
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'create',type:'RECTANGLE'},{op:'update',target:'missing',patch:{name:'skipped'}}]});
 expect(r.status).toBe('partial');expect(r.results[0].residualIds).toHaveLength(1);expect(r.results[1].status).toBe('skipped');expect(f.api.commitUndo).toHaveBeenCalledTimes(1);
});
it('reports backup objects retained after metadata failure and cleanup refusal',async()=>{
 const f=fixture(),n=f.make('TEXT'),clone=n.clone;
 n.clone=()=>{const copy=clone();copy.setPluginData=()=>{throw Error('metadata failed');};copy.remove=()=>{throw Error('cleanup failed');};return copy;};
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'update',target:n.id,patch:{characters:'changed'}}]});
 expect(r.status).toBe('partial');expect(r.results[0].residualIds).toHaveLength(1);expect(n.characters).toBe('');
});
it('does not allow explicit unlock to edit an immutable backup container',async()=>{
 const f=fixture(),n=f.make('TEXT'),e=createExecutor(f.api,()=>true);
 const first:any=await e('execute',{operations:[{op:'update',target:n.id,patch:{characters:'updated'}}]});
 const container=f.nodes.get(first.backups[0].backupId).parent;
 const r:any=await e('execute',{operations:[{op:'update',target:container.id,patch:{locked:false,name:'changed'}}]});
 expect(r.complete).toBe(false);expect(container.locked).toBe(true);
});
it('returns actual effects when a native setter applies then throws',async()=>{
 const f=fixture(),n=f.make('RECTANGLE');let effects:any[]=[];
 Object.defineProperty(n,'effects',{get:()=>effects,set:(value)=>{effects=value;throw Error('EFFECT_SET_FAILED');}});
 const shadow={type:'DROP_SHADOW',color:{r:0,g:0,b:0,a:.2},offset:{x:0,y:4},radius:8};
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'update',target:n.id,patch:{effects:[shadow]}}]});
 expect(r.results[0].mutated).toBe(true);expect(r.results[0].node.effects[0]).toMatchObject(shadow);
});
it('returns actual line stroke caps after an applied-then-thrown setter',async()=>{
 const f=fixture(),n=f.make('LINE');let cap='NONE';
 Object.defineProperty(n,'strokeCap',{get:()=>cap,set:(value)=>{cap=value;throw Error('CAP_SET_FAILED');}});
 const r:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'update',target:n.id,patch:{strokeCap:'ROUND'}}]});
 expect(r.results[0].mutated).toBe(true);expect(r.results[0].node.strokeCap).toBe('ROUND');
});
it('accepts clone placement and lock patches while retaining strict validation',()=>{
 expect(ExecuteInput.safeParse({operations:[{op:'clone',target:'n',name:'copy',x:1,y:2}]}).success).toBe(true);
 expect(ExecuteInput.safeParse({operations:[{op:'update',target:'n',patch:{locked:true}}]}).success).toBe(true);
});

