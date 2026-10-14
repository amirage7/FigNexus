import {expect,it,vi} from 'vitest';
import {QuickPairing} from '../apps/bridge-server/src/quick-pairing';
import {createBridge} from '../apps/bridge-server/src/server';
it('invalidates a challenge after five failed code or retrieval attempts',()=>{
  const p=new QuickPairing('t'.repeat(64),'a'.repeat(64));const poll=p.start(),code=p.start();
  for(let i=0;i<5;i++){
    expect(()=>p.poll(poll.id,'wrong')).toThrow('PAIR_NOT_FOUND');
    expect(()=>p.approve(code.id,code.code==='000000'?'111111':'000000','a'.repeat(64))).toThrow();
  }
  expect(()=>p.poll(poll.id,poll.secret)).toThrow('PAIR_NOT_FOUND');
  expect(()=>p.approve(code.id,code.code,'a'.repeat(64))).toThrow('PAIR_NOT_FOUND');
});
it('public pair endpoints require plugin origin and approval needs a separate local capability',async()=>{
  const token='t'.repeat(64),secret='a'.repeat(64),p=new QuickPairing(token,secret),app=await createBridge(token,false,undefined,{},p);
  try{
    expect((await app.inject({method:'POST',url:'/v1/pair/start',payload:{}})).statusCode).toBe(403);
    const challenge=(await app.inject({method:'POST',url:'/v1/pair/start',headers:{origin:'null'},payload:{}})).json();
    const payload={id:challenge.id,code:challenge.code},auth={authorization:`Bearer ${token}`};
    expect((await app.inject({method:'POST',url:'/v1/pair/approve',headers:auth,payload})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/v1/pair/poll',headers:{origin:'null'},payload:{id:challenge.id,secret:challenge.secret}})).json()).toEqual({state:'pending'});
    expect((await app.inject({method:'POST',url:'/v1/pair/approve',headers:{...auth,'x-figma-pair-approval':secret},payload})).json().approved).toBe(true);
    expect((await app.inject({method:'POST',url:'/v1/pair/poll',headers:{origin:'null'},payload:{id:challenge.id,secret:challenge.secret}})).json()).toEqual({state:'paired',token});
    expect((await app.inject({url:'/v1/status'})).statusCode).toBe(401);
  }finally{await app.close();}
});
it('never returns a credential before local approval and consumes it exactly once',()=>{
  const p=new QuickPairing('t'.repeat(64),'a'.repeat(64));const challenge=p.start();
  expect(p.poll(challenge.id,challenge.secret)).toEqual({state:'pending'});
  expect(()=>p.approve(challenge.id,challenge.code,'wrong')).toThrow('UNAUTHORIZED');
  expect(()=>p.approve(challenge.id,'000000','a'.repeat(64))).toThrow('PAIR_CODE_MISMATCH');
  p.approve(challenge.id,challenge.code,'a'.repeat(64));
  expect(()=>p.poll(challenge.id,'wrong')).toThrow('PAIR_NOT_FOUND');
  expect(p.poll(challenge.id,challenge.secret)).toEqual({state:'paired',token:'t'.repeat(64)});
  expect(()=>p.poll(challenge.id,challenge.secret)).toThrow('PAIR_NOT_FOUND');
});
it('limits pending challenges, expires requests and hides retrieval secrets from listing',()=>{
  vi.useFakeTimers();try{
    const p=new QuickPairing('t'.repeat(64),'a'.repeat(64));const challenge=p.start();
    expect(JSON.stringify(p.pending())).not.toContain(challenge.secret);
    for(let i=1;i<8;i++)p.start();expect(()=>p.start()).toThrow('PAIR_CAPACITY');
    vi.advanceTimersByTime(120001);expect(p.pending()).toEqual([]);
    expect(()=>p.poll(challenge.id,challenge.secret)).toThrow('PAIR_NOT_FOUND');expect(p.start()).toBeTruthy();
  }finally{vi.useRealTimers();}
});
