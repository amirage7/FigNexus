import {afterEach,expect,it,vi} from 'vitest';
import {fixture} from './figma-fixture';
import {ClientMessage,Request} from '../packages/protocol/src/index';
afterEach(()=>{vi.resetModules();vi.unstubAllGlobals();});
async function setup(storage:any){const f=fixture(),sent:any[]=[];f.api.clientStorage=storage;f.api.showUI=vi.fn();f.api.on=vi.fn();f.api.ui={postMessage:(m:any)=>sent.push(m)};vi.stubGlobal('figma',f.api);vi.stubGlobal('__html__','test');await import('../apps/figma-plugin/src/main');return {...f,sent,send:async(m:any)=>{f.api.ui.onmessage(m);await new Promise(r=>setTimeout(r,0));return sent.filter(p=>p.type==='pairing-state'&&p.requestId===m.requestId).at(-1);}};}
function storage(){const data=new Map();return {data,getAsync:vi.fn(async(k:string)=>data.get(k)),setAsync:vi.fn(async(k:string,v:any)=>{data.set(k,v);}),deleteAsync:vi.fn(async(k:string)=>{data.delete(k);})};}
it('saves pairing locally and restores it after plugin restart without restoring write permission',async()=>{
 const s=storage(),token='t'.repeat(64),f=await setup(s);
 const saved=await f.send({type:'pairing-save',requestId:'save',token,mode:'ws'});expect(saved).toMatchObject({saved:true,action:'save'});
 expect(saved.token).toBeUndefined();vi.resetModules();const reopened=await setup(s);
 const loaded=await reopened.send({type:'pairing-load',requestId:'load'});expect(loaded).toMatchObject({saved:true,token,mode:'ws'});
 reopened.api.ui.onmessage({type:'context-request'});expect(reopened.sent.at(-1).context.writeEnabled).toBe(false);
});
it('forgets saved pairing and does not restore stale credentials',async()=>{const s=storage(),f=await setup(s);await f.send({type:'pairing-save',requestId:'save',token:'t'.repeat(64),mode:'http'});expect(await f.send({type:'pairing-forget',requestId:'forget'})).toMatchObject({saved:false});expect(await f.send({type:'pairing-load',requestId:'load'})).toMatchObject({saved:false});});
it('rejects malformed credentials and prevents remote pairing commands',async()=>{const s=storage(),f=await setup(s);await f.send({type:'pairing-save',requestId:'bad',token:'short',mode:'ws'});expect(s.setAsync).not.toHaveBeenCalled();expect(Request.safeParse({type:'request',requestId:'remote',method:'pairing-load'}).success).toBe(false);expect(ClientMessage.safeParse({type:'pairing-load',requestId:'remote'}).success).toBe(false);});
it('reports storage failures without leaking token or raw error details',async()=>{const s=storage(),f=await setup(s);s.setAsync.mockRejectedValue(Error('secret-error'));const r=await f.send({type:'pairing-save',requestId:'save',token:'t'.repeat(64),mode:'ws'});expect(r).toMatchObject({error:'STORAGE_UNAVAILABLE'});expect(JSON.stringify(r)).not.toContain('secret-error');expect(JSON.stringify(r)).not.toContain('t'.repeat(64));});
