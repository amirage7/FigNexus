import {expect,it,vi} from 'vitest';import {ExecuteInput,Result} from '../packages/protocol/src/index';import {createExecutor} from '../apps/figma-plugin/src/executor';import {fixture} from './figma-fixture';
const paths=[{windingRule:'NONZERO',commands:[{op:'M',x:0,y:0},{op:'C',x1:25,y1:0,x2:75,y2:60,x:100,y:60}]}];
function nativeFixture(){const f=fixture();f.api.createVector=()=>{const n=f.make('VECTOR');let value:any=[];Object.defineProperty(n,'vectorPaths',{configurable:true,get:()=>value,set:(v)=>{value=v;n.width=100;n.height=60;n.x=99;n.y=88;}});return n;};f.api.createLine=()=>{const n=f.make('LINE');n.height=0;return n;};return f;}
it('requires structured paths for vectors and disallows vector payloads on ordinary shapes',()=>{
 expect(ExecuteInput.safeParse({operations:[{op:'create',type:'VECTOR',vectorPaths:paths}]}).success).toBe(true);expect(ExecuteInput.safeParse({operations:[{op:'create',type:'VECTOR'}]}).success).toBe(false);expect(ExecuteInput.safeParse({operations:[{op:'create',type:'RECTANGLE',vectorPaths:paths}]}).success).toBe(false);expect(ExecuteInput.safeParse({operations:[{op:'create',type:'LINE',width:22,height:0,stroke:{r:1,g:1,b:1}}]}).success).toBe(true);expect(ExecuteInput.safeParse({operations:[{op:'create',type:'RECTANGLE',height:0}]}).success).toBe(false);
});
it('creates native editable paths and round strokes then reads their true paths and geometry',async()=>{
 const f=nativeFixture(),execute=createExecutor(f.api,()=>true);const created:any=await execute('execute',{operations:[{op:'create',type:'VECTOR',ref:'curve',x:20,y:30,vectorPaths:paths,fills:[],stroke:{r:0,g:1,b:1},strokeWeight:2.5,strokeCap:'ROUND',strokeJoin:'ROUND'}]});expect(created.complete).toBe(true);const n=f.nodes.get(created.refs.curve);expect(n.vectorPaths[0].data).toBe('M 0 0 C 25 0 75 60 100 60');expect(n.x).toBe(20);expect(n.y).toBe(30);expect(n.height).toBe(60);expect(n.strokeCap).toBe('ROUND');const read:any=await execute('get_nodes',{ids:[n.id],fields:['geometry','vectorPaths','strokes']});expect(read.nodes[0].vectorPaths[0].data).toContain('C');expect(read.nodes[0].strokeWeight).toBe(2.5);expect(Result.safeParse({type:'result',requestId:'v-read',ok:true,data:read}).success).toBe(true);
});
it('updates paths with a native backup and restores a vector as a copy',async()=>{
 const f=nativeFixture(),execute=createExecutor(f.api,()=>true);const c:any=await execute('execute',{operations:[{op:'create',type:'VECTOR',ref:'v',vectorPaths:paths}]});const updated:any=await execute('execute',{operations:[{op:'update',target:c.refs.v,patch:{vectorPaths:[{windingRule:'NONZERO',commands:[{op:'M',x:0,y:0},{op:'L',x:40,y:40}]}],strokeCap:'ROUND'}}]});expect(updated.complete).toBe(true);expect(updated.backups).toHaveLength(1);const restored:any=await execute('restore_backup',{backupId:updated.backups[0].backupId,parentId:'p'});expect(restored.complete).toBe(true);expect(restored.created[0].type).toBe('VECTOR');
});
it('rejects paths on nonvectors and denied permission before backup or mutation',async()=>{
 const f=nativeFixture(),n=f.make('RECTANGLE'),execute=createExecutor(f.api,()=>true);const result:any=await execute('execute',{operations:[{op:'update',target:n.id,patch:{vectorPaths:paths}}]});expect(result.complete).toBe(false);expect(result.backups).toEqual([]);await expect(createExecutor(f.api,()=>false)('execute',{operations:[{op:'create',type:'VECTOR',vectorPaths:paths}]})).rejects.toThrow('WRITE_DISABLED');
});
it('creates a true zero-height line with a stroke rather than a thin rectangle',async()=>{
 const f=nativeFixture(),execute=createExecutor(f.api,()=>true);const r:any=await execute('execute',{operations:[{op:'create',type:'LINE',width:22,height:0,x:24,y:30,stroke:{r:1,g:1,b:1},strokeWeight:2}]});expect(r.complete).toBe(true);const n=f.nodes.get(r.created[0].id);expect(n.type).toBe('LINE');expect(n.height).toBe(0);expect(n.width).toBe(22);
});
it('does not stall pagination when paths and paints together exceed the read budget',async()=>{
 const f=nativeFixture(),n=f.make('VECTOR');n.vectorPaths=[{windingRule:'NONZERO',data:'M 0 0 L 1 1 '+ ' '.repeat(6000)}];
 const paint={type:'GRADIENT_LINEAR',gradientTransform:[[0,1,0],[-1,0,1]],gradientStops:Array.from({length:16},(_,i)=>({position:i/15,color:{r:.123456789,g:.234567891,b:.345678912,a:.456789123}}))};
 n.fills=Array(4).fill(paint);n.strokes=Array(4).fill(paint);
 const result:any=await createExecutor(f.api,()=>true)('get_nodes',{ids:[n.id],fields:['geometry','vectorPaths','fills','strokes']});
 expect(result.nodes).toHaveLength(1);expect(result.nextCursor).toBeNull();expect(result.nodes[0].fieldsTruncated).toContain('vectorPaths');expect(result.nodes[0].vectorPathsTruncated).toBe(true);expect(JSON.stringify(result.nodes[0]).length*3).toBeLessThan(36000);
});
it('does not inherit Figma default black strokes on fill-only vectors',async()=>{
 const f=nativeFixture(),factory=f.api.createVector;f.api.createVector=()=>{const n=factory();n.strokes=[{type:'SOLID',color:{r:0,g:0,b:0}}];return n;};
 const result:any=await createExecutor(f.api,()=>true)('execute',{operations:[{op:'create',type:'VECTOR',vectorPaths:paths,fill:{r:1,g:1,b:1}}]});
 expect(result.complete).toBe(true);expect(f.nodes.get(result.created[0].id).strokes).toEqual([]);
});
