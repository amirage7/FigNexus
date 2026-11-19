import {afterEach,expect,it,vi} from 'vitest';
import {PluginConnection} from '../apps/figma-plugin/src/connection';
import {createBridge} from '../apps/bridge-server/src/server';
const context={instanceId:'hidden-ui',document:{id:'0',name:'Test'},page:{id:'p',name:'Page'}};
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('does not close a healthy WebSocket merely because the UI timer was delayed',async()=>{
  vi.useFakeTimers();let socket:any;const sent:any[]=[];
  class FakeSocket{
    onopen?:()=>void;onmessage?:(e:any)=>void;onclose?:()=>void;onerror?:()=>void;
    send(raw:string){const msg=JSON.parse(raw);sent.push(msg);if(msg.type==='hello')this.onmessage?.({data:JSON.stringify({type:'welcome',version:1,sessionId:'stable',heartbeatMs:3000,leaseMs:10000})});}
    close=vi.fn();constructor(){socket=this;queueMicrotask(()=>this.onopen?.());}
  }
  vi.stubGlobal('WebSocket',FakeSocket);const client=new PluginConnection(()=>context,()=>{},()=>{});
  const promise=client.connect('a'.repeat(64),'ws');await vi.advanceTimersByTimeAsync(0);await promise;
  // A timer resumes 65 seconds later although the transport itself stayed open.
  vi.setSystemTime(Date.now()+65000);await vi.advanceTimersByTimeAsync(3000);
  expect(socket.close).not.toHaveBeenCalled();expect(client.sessionId).toBe('stable');expect(sent.some(m=>m.type==='heartbeat')).toBe(true);
  await client.disconnect();
});

it('keeps the polling session during a 65-second pause and resumes without delivering a timed-out write', async () => {
  const app = await createBridge('a'.repeat(64));
  const headers = { authorization: 'Bearer ' + 'a'.repeat(64) };
  try {
    const connection = (await app.inject({ method: 'POST', url: '/v1/connect', headers, payload: {
      type: 'hello', version: 1, token: 'a'.repeat(64), context: { ...context, writeEnabled: true },
    } })).json();
    const id = connection.sessionId;
    expect(connection.leaseMs).toBeGreaterThan(65_000);
    const requested = app.inject({ method: 'POST', url: '/v1/request', headers, payload: {
      sessionId: id, request: { type: 'request', requestId: 'unsent', method: 'execute', params: {
        operations: [{ op: 'create', type: 'FRAME' }],
      } },
    } });
    await vi.waitFor(async () => {
      const activity = (await app.inject({ url: '/v1/audit/status', headers })).json();
      expect(activity.sessionActivity[0]?.active?.requestId).toBe('unsent');
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 65_000);
    const paused = await app.inject({ method: 'POST', url: '/v1/ping', headers, payload: { sessionId: id, requestId: 'paused' } });
    expect(paused.json().code).toBe('PLUGIN_PAUSED');
    const poll = await app.inject({ url: '/v1/poll/' + id, headers });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().requests).toEqual([]);
    expect((await requested).json().code).toBe('TIMEOUT');
    expect((await app.inject({ url: '/v1/status', headers })).json().sessions[0].sessionId).toBe(id);
    const fresh = app.inject({ method: 'POST', url: '/v1/ping', headers, payload: { sessionId: id, requestId: 'fresh' } });
    await vi.waitFor(async () => {
      expect((await app.inject({ url: '/v1/poll/' + id, headers })).json().requests[0]?.requestId).toBe('fresh');
    });
    await app.inject({ method: 'POST', url: '/v1/message/' + id, headers, payload: { type: 'result', requestId: 'fresh', ok: true, data: { pong: true } } });
    expect((await fresh).json().ok).toBe(true);
  } finally { await app.close(); }
});
