import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createBridge } from '../apps/bridge-server/src/server';
const token = 'a'.repeat(64);
const context = { instanceId: 'test', document: { id: '0:0', name: 'Test' }, page: { id: '0:1', name: 'Page' } };
const hello = { type: 'hello', version: 1, token, context };
const apps: Awaited<ReturnType<typeof createBridge>>[] = [];
async function setup() { const app = await createBridge(token); apps.push(app); return app; }
const auth = { authorization: `Bearer ${token}` };
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
describe('bridge transport', () => {
  it('records preview dispatch and progress in redacted diagnostics',async()=>{
    const app=await setup();const sessionId=(await app.inject({method:'POST',url:'/v1/connect',headers:auth,payload:hello})).json().sessionId;
    const pending=app.inject({method:'POST',url:'/v1/preview',headers:auth,payload:{sessionId,params:{nodeId:'frame',maxSize:256}}});
    await new Promise(r=>setTimeout(r,10));
    const request=(await app.inject({url:`/v1/poll/${sessionId}`,headers:auth})).json().requests[0];
    await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers:auth,payload:{type:'progress',requestId:request.requestId,stage:'started'}});
    const diagnostic=(await app.inject({url:'/v1/audit/status',headers:auth})).json();
    expect(diagnostic.connectionDiagnostics.some((d:any)=>d.requestId===request.requestId&&d.stages.some((p:any)=>p.stage==='started'))).toBe(true);
    await app.inject({method:'POST',url:`/v1/message/${sessionId}`,headers:auth,payload:{type:'result',requestId:request.requestId,ok:false,error:{code:'FRAME_REQUIRED',message:'test'}}});
    expect((await pending).statusCode).toBe(400);
  });
  it('keeps WebSocket sessions alive through native pongs without UI heartbeats',async()=>{
    const app=await (createBridge as any)(token,false,undefined,{leaseMs:100,wsHeartbeatMs:25});apps.push(app);
    const address=await app.listen({host:'127.0.0.1',port:0});const socket=new WebSocket(address.replace('http:','ws:')+'/v1/ws');
    let pingCount=0;socket.on('ping',()=>{pingCount++;});
    const welcome=new Promise<any>(resolve=>socket.once('message',d=>resolve(JSON.parse(d.toString()))));
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});socket.send(JSON.stringify(hello));const id=(await welcome).sessionId;
    try{await new Promise(r=>setTimeout(r,350));const status=(await app.inject({url:'/v1/status',headers:auth})).json();expect(pingCount).toBeGreaterThan(2);expect(status.sessions[0]?.sessionId).toBe(id);}finally{socket.terminate();}
  });
  it('expires a silent WebSocket that does not answer native pings',async()=>{
    const app=await (createBridge as any)(token,false,undefined,{leaseMs:100,wsHeartbeatMs:25});apps.push(app);
    const address=await app.listen({host:'127.0.0.1',port:0});const socket=new WebSocket(address.replace('http:','ws:')+'/v1/ws',{autoPong:false});
    const welcome=new Promise<any>(resolve=>socket.once('message',d=>resolve(JSON.parse(d.toString()))));await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});socket.send(JSON.stringify(hello));await welcome;
    try{await new Promise(r=>setTimeout(r,350));expect((await app.inject({url:'/v1/status',headers:auth})).json().online).toBe(false);}finally{socket.terminate();}
  });
  it('permits plugin null-origin preflight and private-network preflight', async () => {
    const app = await setup();
    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/connect', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type', 'access-control-request-private-network': 'true' } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('null');
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');
  });
  it('rejects a WebSocket with the wrong token', async () => {
    const app = await setup();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/v1/ws');
    const closed = new Promise<number>((resolve, reject) => { socket.once('close', code => resolve(code)); socket.once('error', reject); });
    await new Promise<void>(resolve => socket.once('open', resolve));
    socket.send(JSON.stringify({ ...hello, token: 'b'.repeat(64) }));
    expect(await closed).toBe(1008);
    expect((await app.inject({ url: '/v1/status', headers: auth })).json().online).toBe(false);
  });
  it('requires token and validates schemas', async () => {
    const app = await setup();
    expect((await app.inject('/v1/status')).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/status', headers: auth })).json().online).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v1/connect', headers: auth, payload: { ...hello, code: 'eval' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/connect', headers: auth, payload: { ...hello, token: 'b'.repeat(64) } })).statusCode).toBe(401);
  });
  it('round trips a polling request and disconnects', async () => {
    const app = await setup();
    const sessionId = (await app.inject({ method: 'POST', url: '/v1/connect', headers: auth, payload: hello })).json().sessionId;
    const pending = app.inject({ method: 'POST', url: '/v1/ping', headers: auth, payload: { sessionId, requestId: 'r1' } });
    await new Promise(r => setTimeout(r, 20));
    const poll = await app.inject({ url: `/v1/poll/${sessionId}`, headers: auth });
    expect(poll.json().requests[0]).toEqual({ type: 'request', method: 'ping', requestId: 'r1' });
    await app.inject({ method: 'POST', url: `/v1/message/${sessionId}`, headers: auth, payload: { type: 'result', requestId: 'r1', ok: true, data: { pong: true } } });
    expect((await pending).json().data.pong).toBe(true);
    await app.inject({ method: 'DELETE', url: `/v1/session/${sessionId}`, headers: auth });
    expect((await app.inject({ url: '/v1/status', headers: auth })).json().online).toBe(false);
  });
  it('authenticates WebSocket and reports offline after close', async () => {
    const app = await setup();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/v1/ws');
    const welcome = new Promise<any>(resolve => socket.once('message', d => resolve(JSON.parse(d.toString()))));
    await new Promise<void>(resolve => socket.once('open', resolve)); socket.send(JSON.stringify(hello));
    const sessionId = (await welcome).sessionId; expect(sessionId).toBeTruthy();
    socket.on('message', raw => { const r = JSON.parse(raw.toString()); if (r.type === 'request') socket.send(JSON.stringify({ type: 'result', requestId: r.requestId, ok: true, data: { pong: true, context } })); });
    expect((await app.inject({ method: 'POST', url: '/v1/ping', headers: auth, payload: { sessionId, requestId: 'ws1' } })).json().ok).toBe(true);
    await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(); });
    await new Promise(r => setTimeout(r, 20));
    expect((await app.inject({ url: '/v1/status', headers: auth })).json().online).toBe(false);
  });
});
