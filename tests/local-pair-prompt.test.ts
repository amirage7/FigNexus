import {expect,it,vi} from 'vitest';
import {QuickPairing} from '../apps/bridge-server/src/quick-pairing';
import {LocalPairPrompt} from '../apps/bridge-server/src/local-pair-prompt';
const token='t'.repeat(64),secret='a'.repeat(64);
it('returns challenge before confirmation and approves only its own challenge',async()=>{
 let finish!:(v:boolean)=>void;const confirm=vi.fn(()=>new Promise<boolean>(r=>finish=r));const pairing=new QuickPairing(token,secret),other=pairing.start();const prompt=new LocalPairPrompt(pairing,secret,confirm);
 const p=prompt.start();await Promise.resolve();expect(confirm).toHaveBeenCalledWith(p.code,expect.any(AbortSignal));expect(pairing.poll(p.id,p.secret)).toEqual({state:'pending'});
 finish(true);await prompt.idle();expect(pairing.poll(p.id,p.secret)).toEqual({state:'paired',token});expect(pairing.poll(other.id,other.secret)).toEqual({state:'pending'});
});
it('limits simultaneous dialogs and immediate repeat starts',async()=>{
 let finish!:(v:boolean)=>void;let time=1000;const pairing=new QuickPairing(token,secret),prompt=new LocalPairPrompt(pairing,secret,()=>new Promise(r=>finish=r),()=>time);
 prompt.start();await Promise.resolve();expect(()=>prompt.start()).toThrow('PAIR_BUSY');finish(false);await prompt.idle();expect(()=>prompt.start()).toThrow('PAIR_RATE_LIMIT');time+=10001;prompt.start();await Promise.resolve();finish(false);await prompt.idle();
});
it.each(['reject','throw'] as const)('revokes %s challenges and never discloses credentials',async(kind)=>{
 const pairing=new QuickPairing(token,secret),prompt=new LocalPairPrompt(pairing,secret,async()=>{if(kind==='throw')throw Error('private-secret');return false;});const p=prompt.start();await prompt.idle();expect(()=>pairing.poll(p.id,p.secret)).toThrow('PAIR_NOT_FOUND');
});
it('closing aborts only its own dialog and cannot approve after close',async()=>{
 let finish!:(v:boolean)=>void;let signal:AbortSignal|undefined;const pairing=new QuickPairing(token,secret),prompt=new LocalPairPrompt(pairing,secret,(_,s)=>{signal=s;return new Promise(r=>finish=r);});const p=prompt.start();await Promise.resolve();prompt.close();expect(signal?.aborted).toBe(true);finish(true);await prompt.idle();expect(()=>pairing.poll(p.id,p.secret)).toThrow('PAIR_NOT_FOUND');expect(()=>prompt.start()).toThrow('PAIR_CLOSED');
});
it('an expired dialog cannot grant a new challenge',async()=>{
 vi.useFakeTimers();try{let finish!:(v:boolean)=>void;const pairing=new QuickPairing(token,secret),prompt=new LocalPairPrompt(pairing,secret,()=>new Promise(r=>finish=r));const p=prompt.start();await Promise.resolve();vi.advanceTimersByTime(120001);finish(true);await prompt.idle();expect(()=>pairing.poll(p.id,p.secret)).toThrow('PAIR_NOT_FOUND');}finally{vi.useRealTimers();}
});
it('pair/start opens its local prompt only for a valid plugin request and closes it with the service',async()=>{
 const {createBridge}=await import('../apps/bridge-server/src/server');const pairing=new QuickPairing(token,secret);let finish!:(v:boolean)=>void;const confirm=vi.fn((_code:string,_signal:AbortSignal)=>new Promise<boolean>(r=>finish=r)),prompt=new LocalPairPrompt(pairing,secret,confirm);const app=await createBridge(token,false,undefined,{},pairing,prompt);
 try{expect((await app.inject({method:'POST',url:'/v1/pair/start',headers:{origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);expect(confirm).not.toHaveBeenCalled();const result=await app.inject({method:'POST',url:'/v1/pair/start',headers:{origin:'null'},payload:{}});expect(result.statusCode).toBe(200);await Promise.resolve();expect(confirm).toHaveBeenCalledWith(result.json().code,expect.any(AbortSignal));expect((await app.inject({method:'POST',url:'/v1/pair/start',headers:{origin:'null'},payload:{}})).statusCode).toBe(429);await app.close();expect(confirm.mock.calls[0]![1].aborted).toBe(true);}finally{finish?.(false);await app.close();await prompt.idle();}
});
it('authenticates cancellation with the challenge secret and aborts only that dialog',async()=>{
 let finish!:(v:boolean)=>void;let signal!:AbortSignal;const pairing=new QuickPairing(token,secret),other=pairing.start(),prompt=new LocalPairPrompt(pairing,secret,(_c,s)=>{signal=s;return new Promise(r=>finish=r);});const p=prompt.start();await Promise.resolve();expect(()=>(prompt as any).cancel(p.id,'x'.repeat(64))).toThrow('PAIR_NOT_FOUND');expect(signal.aborted).toBe(false);(prompt as any).cancel(p.id,p.secret);expect(signal.aborted).toBe(true);finish(true);await prompt.idle();expect(()=>pairing.poll(p.id,p.secret)).toThrow('PAIR_NOT_FOUND');expect(pairing.poll(other.id,other.secret)).toEqual({state:'pending'});
});
it('the public cancel endpoint needs the matching challenge secret and plugin origin',async()=>{
 const {createBridge}=await import('../apps/bridge-server/src/server');let finish!:(v:boolean)=>void;let signal!:AbortSignal;const pairing=new QuickPairing(token,secret),prompt=new LocalPairPrompt(pairing,secret,(_c,s)=>{signal=s;return new Promise(r=>finish=r);}),app=await createBridge(token,false,undefined,{},pairing,prompt);try{const p=(await app.inject({method:'POST',url:'/v1/pair/start',headers:{origin:'null'},payload:{}})).json();await Promise.resolve();expect((await app.inject({method:'POST',url:'/v1/pair/cancel',headers:{origin:'null'},payload:{id:p.id,secret:'b'.repeat(64)}})).statusCode).toBe(400);expect(signal.aborted).toBe(false);expect((await app.inject({method:'POST',url:'/v1/pair/cancel',payload:{id:p.id,secret:p.secret}})).statusCode).toBe(403);expect((await app.inject({method:'POST',url:'/v1/pair/cancel',headers:{origin:'null'},payload:{id:p.id,secret:p.secret}})).json()).toEqual({cancelled:true});expect(signal.aborted).toBe(true);finish(true);await prompt.idle();expect(()=>pairing.poll(p.id,p.secret)).toThrow('PAIR_NOT_FOUND');}finally{finish?.(false);await app.close();}
});
