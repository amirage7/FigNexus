import {expect,it,vi} from 'vitest';
import {QuickPairingClient} from '../apps/figma-plugin/src/quick-pairing-client';
it('preserves Window receiver when using a native browser fetch implementation',async()=>{
  let calls=0;const tokens:string[]=[];
  const fetcher:any=async function(this:unknown){
    if(this!==globalThis)throw new TypeError('Illegal invocation');
    return {ok:true,json:async()=>calls++?{state:'paired',token:'t'.repeat(64)}:{id:'00000000-0000-4000-8000-000000000001',secret:'s'.repeat(64),code:'123456',expires:Date.now()+10000}};
  };
  await new QuickPairingClient(async t=>{tokens.push(t);},()=>{},fetcher).start();expect(tokens).toEqual(['t'.repeat(64)]);
});
it('pairs in plugin browsers without AbortSignal.any support',async()=>{
  const any=vi.spyOn(AbortSignal,'any');any.mockImplementation(()=>{throw new TypeError('AbortSignal.any is not a function');});
  let calls=0;const tokens:string[]=[];
  try{
    const fetcher:any=async()=>({ok:true,json:async()=>calls++?{state:'paired',token:'t'.repeat(64)}:{id:'00000000-0000-4000-8000-000000000001',secret:'s'.repeat(64),code:'123456',expires:Date.now()+10000}});
    await new QuickPairingClient(async t=>{tokens.push(t);},()=>{},fetcher).start();expect(tokens).toEqual(['t'.repeat(64)]);
  }finally{any.mockRestore();}
});
it('cancels credential acceptance while a connection welcome is still pending',async()=>{
  let calls=0,acceptStarted=false,disconnected=false,connected=false;let welcome!:()=>void;
  const fetcher:any=async()=>({ok:true,json:async()=>calls++?{state:'paired',token:'t'.repeat(64)}:{id:'00000000-0000-4000-8000-000000000001',secret:'s'.repeat(64),code:'123456',expires:Date.now()+10000}});
  const c=new QuickPairingClient(async(_token,signal)=>{
    acceptStarted=true;signal.addEventListener('abort',()=>{disconnected=true;});
    await new Promise<void>(r=>{welcome=r;});if(!signal.aborted)connected=true;
  },()=>{},fetcher);
  const pending=c.start();for(let i=0;i<10&&!acceptStarted;i++)await Promise.resolve();
  c.cancel();expect(disconnected).toBe(true);welcome();await pending;expect(connected).toBe(false);
});
it('shows matching code while pending and only accepts an approved credential',async()=>{
  const notices:any[]=[],tokens:string[]=[];let calls=0;
  const fetcher:any=async()=>({ok:true,json:async()=>calls++===0?{id:'00000000-0000-4000-8000-000000000001',secret:'s'.repeat(64),code:'123456',expires:Date.now()+10000}:calls===2?{state:'pending'}:{state:'paired',token:'t'.repeat(64)}});
  const c=new QuickPairingClient(async t=>{tokens.push(t);},p=>notices.push(p),fetcher,async()=>{});
  await c.start();expect(notices.some(p=>p.code==='123456')).toBe(true);expect(tokens).toEqual(['t'.repeat(64)]);
});
it('cancels a stale response and refuses malformed credentials',async()=>{
  let resolve!:(value:any)=>void;const tokens:string[]=[];
  const fetcher:any=()=>new Promise(r=>{resolve=r;});
  const c=new QuickPairingClient(async t=>{tokens.push(t);},()=>{},fetcher);
  const pending=c.start();c.cancel();resolve({ok:true,json:async()=>({id:'00000000-0000-4000-8000-000000000001',secret:'s'.repeat(64),code:'123456',expires:Date.now()+10000})});await pending;expect(tokens).toEqual([]);
  let calls=0;const bad:any=async()=>({ok:true,json:async()=>calls++?{state:'paired',token:'short'}:{id:'00000000-0000-4000-8000-000000000001',secret:'s'.repeat(64),code:'123456',expires:Date.now()+10000}});
  const notices:any[]=[];const d=new QuickPairingClient(async t=>{tokens.push(t);},p=>notices.push(p),bad);await d.start();expect(tokens).toEqual([]);expect(notices.at(-1).notice).toContain('失败');
});
it('requests server-side cancellation when abandoning a pending local dialog',async()=>{
 const sent:string[]=[],views:any[]=[];let resume!:()=>void;const id='00000000-0000-4000-8000-000000000001',secret='s'.repeat(64);const fetcher:any=async(url:string,opts:any)=>{sent.push(url);if(url.endsWith('/cancel')){expect(JSON.parse(opts.body)).toEqual({id,secret});return {ok:true,json:async()=>({cancelled:true})};}return {ok:true,json:async()=>url.endsWith('/start')?{id,secret,code:'123456',expires:Date.now()+10000}:{state:'pending'}};};const c=new QuickPairingClient(async()=>{throw Error('Must not connect');},v=>views.push(v),fetcher,()=>new Promise(r=>resume=r));const pending=c.start();for(let i=0;i<20&&!resume;i++)await Promise.resolve();c.cancel();resume();await pending;expect(sent.some(url=>url.endsWith('/v1/pair/cancel'))).toBe(true);
});
