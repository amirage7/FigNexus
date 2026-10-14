import {expect,it} from 'vitest';
import {Request,Result,ExecuteInput} from '../packages/protocol/src/index';
import {createExecutor} from '../apps/figma-plugin/src/executor';
import {fixture} from './figma-fixture';
it('accepts strict design requests and native gradient/effect execution payloads',()=>{
  expect(Request.safeParse({type:'request',requestId:'p',method:'design',params:{action:'pages_list'}}).success).toBe(true);
  const fill={type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:1}}]};
  expect(ExecuteInput.safeParse({operations:[{op:'create',type:'RECTANGLE',fills:[fill],effects:[]}]}).success).toBe(true);
});
it('routes bounded page reads through design and validates a canonical native result',async()=>{
  const f=fixture();const execute=createExecutor(f.api,()=>true);
  const data=await execute('design' as any,{action:'pages_list'});
  expect(Result.safeParse({type:'result',requestId:'pages',ok:true,data}).success).toBe(true);
  expect((data as any).design.pages[0].id).toBe(f.api.currentPage.id);
});
it('creates and updates native paint/effects and reads them back without adding color-band nodes',async()=>{
  const f=fixture(),execute=createExecutor(f.api,()=>true);
  const gradient={type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:1}}]};
  const shadow={type:'DROP_SHADOW',color:{r:0,g:0,b:0,a:.2},offset:{x:0,y:4},radius:8};
  const created:any=await execute('execute',{operations:[{op:'create',type:'FRAME',fills:[gradient],effects:[shadow]}]});
  expect(created.complete).toBe(true);const id=created.created[0].id;expect(f.nodes.get(id).children).toHaveLength(0);
  const read:any=await execute('get_nodes',{ids:[id],fields:['fills','effects']});expect(read.nodes[0].fills[0].type).toBe('GRADIENT_LINEAR');expect(read.nodes[0].effects[0].type).toBe('DROP_SHADOW');
  const updated:any=await execute('execute',{operations:[{op:'update',target:id,patch:{effects:[],fills:[gradient]}}]});
  expect(updated.complete).toBe(true);expect(updated.backups).toHaveLength(1);expect(f.nodes.get(id).effects).toEqual([]);
});
it('preserves native SOLID visibility and blend mode while keeping legacy default readback',async()=>{
 const f=fixture(),execute=createExecutor(f.api,()=>true),node=f.make('RECTANGLE');
 node.fills=[{type:'SOLID',color:{r:1,g:0,b:0},opacity:.5,visible:false,blendMode:'MULTIPLY'},{type:'SOLID',color:{r:0,g:1,b:0},opacity:.75}];
 const read:any=await execute('get_nodes',{ids:[node.id],fields:['fills']});
 expect(read.nodes[0].fills[0]).toMatchObject({type:'SOLID',visible:false,blendMode:'MULTIPLY',opacity:.5});
 expect(read.nodes[0].fills[1]).toEqual({r:0,g:1,b:0,a:.75});
 expect(Result.safeParse({type:'result',requestId:'solid',ok:true,data:read}).success).toBe(true);
});
