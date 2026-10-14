import { describe, it, expect, vi } from 'vitest';
import { Sessions } from '../packages/core/src/index';

const file = { instanceId: 'instance-1', document: { id: '0:0', name: 'Design' }, page: { id: '0:1', name: 'Page' } };
describe('session boundary', () => {
  it('retains a live session and serial barrier after timeout, caches late result without replay',async()=>{
    vi.useFakeTimers();const s=new Sessions(100000,50),sent:any[]=[];
    const id=s.connect(file,'ws',r=>sent.push(r));
    try{
      const first=s.request(id,'slow').catch(e=>e.message);
      await vi.advanceTimersByTimeAsync(51);expect(await first).toBe('TIMEOUT');
      expect(s.status().online).toBe(true);
      await expect(s.request(id,'slow')).rejects.toThrow('TIMEOUT');
      const next=s.request(id,'next');expect(sent.map(r=>r.requestId)).toEqual(['slow']);
      const result:any={type:'result',requestId:'slow',ok:true,data:{pong:true}};
      s.respond(id,result);expect(await s.request(id,'slow')).toEqual(result);
      expect(sent.map(r=>r.requestId)).toEqual(['slow','next']);
      s.respond(id,{type:'result',requestId:'next',ok:true,data:{pong:true}});await next;
    }finally{s.close();vi.useRealTimers();}
  });
  it('does not dispatch a queued request after its waiting deadline expires',async()=>{
    vi.useFakeTimers();const s=new Sessions(100000,50),sent:any[]=[];
    const id=s.connect(file,'ws',r=>sent.push(r));
    try{
      const active=s.request(id,'a').catch(e=>e.message),queued=s.request(id,'b').catch(e=>e.message);
      await vi.advanceTimersByTimeAsync(51);expect(await active).toBe('TIMEOUT');expect(await queued).toBe('TIMEOUT');
      s.respond(id,{type:'result',requestId:'a',ok:true,data:{pong:true}});expect(sent).toHaveLength(1);
      s.disconnect(id);expect(s.status().online).toBe(false);
    }finally{s.close();vi.useRealTimers();}
  });
  it('allows exact retry after local confirmation is requested',async()=>{
    const s=new Sessions();const sent:any[]=[];const id=s.connect(file,'ws',r=>sent.push(r));
    const request:any={type:'request',requestId:'confirm',method:'execute',params:{operations:[{op:'delete',target:'n'}]}};
    try{
      const first=s.request(id,'confirm',request);s.respond(id,{type:'result',requestId:'confirm',ok:false,error:{code:'CONFIRMATION_REQUIRED',message:'local consent required'}});await first;
      const second=s.request(id,'confirm',request);expect(sent).toHaveLength(2);s.respond(id,{type:'result',requestId:'confirm',ok:false,error:{code:'TEST_STOP',message:'test only'}});await second;
    }finally{s.close();}
  });
  it('rejects changed payload under a cached or pending request ID', async () => {
    const s = new Sessions(); const sent: any[] = [];
    const id = s.connect(file, 'ws', r => sent.push(r));
    try {
      const first = s.request(id, 'same');
      await expect(s.request(id, 'same', { type: 'request', requestId: 'same', method: 'execute', params: { operations: [{ op: 'create', type: 'FRAME' }] } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      s.respond(id, { type: 'result', requestId: 'same', ok: true, data: { pong: true } }); await first;
      await expect(s.request(id, 'same', { type: 'request', requestId: 'same', method: 'execute', params: { operations: [{ op: 'create', type: 'FRAME' }] } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      expect(sent).toHaveLength(1);
    } finally { s.close(); }
  });
  it('bounds total request time including queue wait', async () => {
    vi.useFakeTimers();
    const s = new Sessions(10000, 50);
    try {
      const id = s.connect(file, 'ws', () => {});
      const first = s.request(id, 'first');
      const second = s.request(id, 'second').catch(e => e.message);
      await vi.advanceTimersByTimeAsync(40);
      s.respond(id, { type: 'result', requestId: 'first', ok: true, data: { pong: true } }); await first;
      await vi.advanceTimersByTimeAsync(11);
      expect(s.status().online).toBe(true);
      expect(await second).toBe('TIMEOUT');
    } finally { s.close(); vi.useRealTimers(); }
  });
  it('rejects an offline request', async () => {
    const sessions = new Sessions();
    await expect(sessions.request('missing', 'a')).rejects.toThrow('OFFLINE');
  });
  it('correlates results and caches duplicate request ids', async () => {
    const sessions = new Sessions();
    const sent: any[] = [];
    const id = sessions.connect(file, 'ws', m => sent.push(m));
    const result = sessions.request(id, 'a');
    await Promise.resolve();
    sessions.respond(id, { type: 'result', requestId: 'wrong', ok: true, data: { pong: true } });
    sessions.respond(id, { type: 'result', requestId: 'a', ok: true, data: { pong: true } });
    expect(await result).toEqual({ type: 'result', requestId: 'a', ok: true, data: { pong: true } });
    expect(await sessions.request(id, 'a')).toEqual(await result);
    expect(sent).toHaveLength(1);
    sessions.disconnect(id);
    expect(sessions.status().sessions).toHaveLength(0);
  });
  it('rejects pending work on disconnect', async () => {
    const sessions = new Sessions();
    const id = sessions.connect(file, 'ws', () => {});
    const pending = sessions.request(id, 'a');
    const assertion = expect(pending).rejects.toThrow('OFFLINE');
    await Promise.resolve();
    sessions.disconnect(id);
    await assertion;
  });
  it('expires stale polling sessions and times out unanswered requests', async () => {
    const sessions = new Sessions(10, 10);
    const id = sessions.connect(file, 'http', () => {});
    await expect(sessions.request(id, 'a')).rejects.toThrow('TIMEOUT');
    sessions.expire(Date.now() + 100);
    expect(sessions.status().online).toBe(false);
  });
  it('serializes requests and cannot satisfy another session', async () => {
    const sessions = new Sessions();
    const sent: any[] = [];
    const a = sessions.connect(file, 'ws', r => sent.push(r));
    const b = sessions.connect({ ...file, instanceId: 'other' }, 'http', () => {});
    const first = sessions.request(a, '1'), second = sessions.request(a, '2');
    expect(sent).toHaveLength(1);
    sessions.respond(b, { type: 'result', requestId: '1', ok: true, data: { pong: true } });
    expect(sent).toHaveLength(1);
    sessions.respond(a, { type: 'result', requestId: '1', ok: true, data: { pong: true } });
    await first; expect(sent).toHaveLength(2);
    sessions.respond(a, { type: 'result', requestId: '2', ok: true, data: { pong: true } });
    await second; sessions.close();
  });
  it('limits pending work and replaces reconnecting instances', async () => {
    const sessions = new Sessions();
    const a = sessions.connect(file, 'ws', () => {});
    const jobs = Array.from({ length: 32 }, (_, i) => sessions.request(a, String(i)).catch(e => e.message));
    await expect(sessions.request(a, 'overflow')).rejects.toThrow('QUEUE_FULL');
    const b = sessions.connect(file, 'http', () => {});
    expect(sessions.status().sessions.map(s => s.sessionId)).toEqual([b]);
    expect(await Promise.all(jobs)).toEqual(Array(32).fill('OFFLINE'));
    sessions.close();
  });
});
