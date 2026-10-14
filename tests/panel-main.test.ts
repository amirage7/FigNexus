import {afterEach,expect,it,vi} from 'vitest';import {fixture} from './figma-fixture';
afterEach(()=>{vi.resetModules();vi.unstubAllGlobals();});
async function setup(data=new Map<string,any>()){
 const f=fixture(),sent:any[]=[],resize=vi.fn();f.api.clientStorage={getAsync:async(k:string)=>data.get(k),setAsync:async(k:string,v:any)=>{data.set(k,v);}};f.api.ui={resize,postMessage:(m:any)=>sent.push(m)};f.api.showUI=vi.fn();f.api.on=vi.fn();vi.stubGlobal('figma',f.api);vi.stubGlobal('__html__','test');await import('../apps/figma-plugin/src/main');
 const send=async(m:any)=>{f.api.ui.onmessage(m);await new Promise(r=>setTimeout(r,0));};return {...f,sent,resize,data,send};
}
it('keeps the same plugin runtime, edit consent and ping response across folding',async()=>{
 const f=await setup(),initialSize=f.nodes.size;await f.send({type:'set-write',enabled:true});const before=f.sent.at(-1).context;await f.send({type:'panel-mode',compact:true});await f.send({type:'request',requestId:'compact-ping',method:'ping'});expect(f.sent.at(-1).data).toMatchObject({pong:true,context:before});expect(f.resize).toHaveBeenLastCalledWith(220,44);await f.send({type:'panel-mode',compact:false});await f.send({type:'request',requestId:'expanded-ping',method:'ping'});expect(f.sent.at(-1).data.context.instanceId).toBe(before.instanceId);expect(f.nodes.size).toBe(initialSize);
});
it('restores compact layout after restart without restoring edit permission',async()=>{
 const f=await setup();await f.send({type:'set-write',enabled:true});await f.send({type:'panel-mode',compact:true});vi.resetModules();const reopened=await setup(f.data);await reopened.send({type:'panel-load'});expect(reopened.resize).toHaveBeenLastCalledWith(220,44);await reopened.send({type:'context-request'});expect(reopened.sent.at(-1).context.writeEnabled).toBe(false);
});
it('expands for a real pending deletion and refuses fold or preference reload until handled',async()=>{
 const f=await setup();await f.send({type:'set-write',enabled:true});await f.send({type:'panel-mode',compact:true});const n=f.make('RECTANGLE');await f.send({type:'request',requestId:'compact-delete',method:'execute',params:{operations:[{op:'delete',target:n.id}]}});expect(f.resize).toHaveBeenLastCalledWith(420,470);expect(f.sent.some(m=>m.type==='confirmation')).toBe(true);await f.send({type:'panel-mode',compact:true});await f.send({type:'panel-load'});expect(f.sent.at(-1)).toMatchObject({type:'panel-state',compact:false});expect(n.removed).toBe(false);expect(f.data.get('ai-bridge-panel-v1').compact).toBe(true);
});
