import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import { Sessions } from '@bridge/core';
import { ClientMessage, Hello, Heartbeat, PingInput, OperationInput, PreviewInput, PreviewMeta, PreviewChunk, Result, VERSION,isWriteRequest, type Request } from '@bridge/protocol';
import { PreviewStore } from './previews';
import { z } from 'zod';
import type {AuditStore} from './audit';
import {AuditValidationError} from './audit';
import type {QuickPairing} from './quick-pairing';
import type {LocalPairPrompt} from './local-pair-prompt';

export async function createBridge(token: string, logging = false, audit?:AuditStore, timing:{leaseMs?:number;wsHeartbeatMs?:number}={},quickPairing?:QuickPairing,localPrompt?:LocalPairPrompt) {
  if (token.length < 32 || token.length > 256) throw new Error('Token must be 32–256 characters');
  const app = Fastify({ bodyLimit: 65_536, logger: logging ? { redact: ['req.headers.authorization','req.headers.x-figma-pair-approval'] } : false });
  const leaseMs=timing.leaseMs??10000,wsHeartbeatMs=timing.wsHeartbeatMs??3000;
  if(!Number.isSafeInteger(leaseMs)||!Number.isSafeInteger(wsHeartbeatMs)||wsHeartbeatMs<1||leaseMs<=wsHeartbeatMs)throw Error('Invalid heartbeat timing');
  const sessions = new Sessions(leaseMs);
  const previews = new PreviewStore();
  const polls = new Map<string, Request[]>();
  let auditFailure=false;
  const diagnostics=new Map<string,{requestId:string;instanceId:string;pageId:string;dispatchedAt:number;stages:{stage:string;at:number}[]}>();
  const diagnosticKey=(instanceId:string,requestId:string)=>JSON.stringify([instanceId,requestId]);
  const trackDispatch=(id:string,request:Request)=>{
    const session=getSession(id);if(!session)throw Error('OFFLINE');
    const key=diagnosticKey(session.context.instanceId,request.requestId);
    if(!diagnostics.has(key)){diagnostics.set(key,{requestId:request.requestId,instanceId:session.context.instanceId,pageId:session.context.page.id,dispatchedAt:Date.now(),stages:[]});if(diagnostics.size>100)diagnostics.delete(diagnostics.keys().next().value!);}
    return sessions.request(id,request.requestId,request);
  };
  const receiveProgress=(id:string,p:{requestId:string;stage:string})=>{
    const session=getSession(id);if(!session)return;const entry=diagnostics.get(diagnosticKey(session.context.instanceId,p.requestId));if(!entry)return;
    entry.stages.push({stage:p.stage,at:Date.now()});if(entry.stages.length>10)entry.stages.shift();
  };
  const getSession=(id:string)=>sessions.status().sessions.find(s=>s.sessionId===id);
  const receiveResult=async(id:string,result:Result)=>{
    const session=getSession(id);if(!session)return;
    let delivered=result;
    if(audit){try{await audit.result(session.context.instanceId,result);}catch(e){if(e instanceof AuditValidationError)throw e;auditFailure=true;delivered={...result,auditWarning:'AUDIT_WRITE_FAILED'};}}
    sessions.respond(id,delivered);
  };
  const valid = (value: unknown) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['access-control-request-private-network'] === 'true' && ['null','https://www.figma.com','https://figma.com'].includes(req.headers.origin ?? '')) reply.header('Access-Control-Allow-Private-Network', 'true');
  });
  await app.register(cors, { origin: ['null', 'https://www.figma.com', 'https://figma.com'], methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Authorization','Content-Type'] });
  await app.register(websocket, { options: { maxPayload: 65_536 } });
  app.addHook('onRequest', async (req, reply) => {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return reply.code(403).send({ code: 'INVALID_HOST' });
    if (req.method === 'OPTIONS') return;
    if(quickPairing&&req.method==='POST'&&['/v1/pair/start','/v1/pair/poll','/v1/pair/cancel'].includes(req.url)){
      if(!['null','https://www.figma.com','https://figma.com'].includes(req.headers.origin??''))return reply.code(403).send({code:'INVALID_ORIGIN'});
      return;
    }
    if (req.url === '/v1/ws' && req.headers.upgrade?.toLowerCase() === 'websocket') return;
    if (!valid(req.headers.authorization?.replace(/^Bearer /, ''))) return reply.code(401).send({ code: 'UNAUTHORIZED' });
  });
  app.setErrorHandler((error, req, reply) => {
    const code = error instanceof Error ? error.message : 'INTERNAL';
    const status = code === 'AUDIT_UNAVAILABLE' ? 503 : code === 'OFFLINE'||code==='PREVIEW_NATIVE_BUSY'||code==='PREVIEW_INVALIDATED'||code==='PAGE_CHANGED' ? 409 : ['TIMEOUT','NATIVE_NODE_TIMEOUT','NATIVE_EXPORT_TIMEOUT','PREVIEW_PENDING'].includes(code) ? 504 : code === 'QUEUE_FULL' || code === 'CAPACITY'||code==='PAIR_BUSY'||code==='PAIR_RATE_LIMIT'||code==='PAIR_CAPACITY' ? 429 : 400;
    req.log.warn({ code: status === 400 ? 'INVALID_REQUEST' : code }, 'Bridge request failed');
    reply.code(status).send({ code: status === 400 ? 'INVALID_REQUEST' : code });
  });
  const welcome = (sessionId: string) => ({ type: 'welcome', version: VERSION, sessionId, heartbeatMs: 3000, leaseMs: sessions.leaseMs });
  app.get('/v1/status', async () => sessions.status());
  app.get('/v1/health',async()=>({service:'figma-ai-bridge',version:'0.3.5',protocolVersion:1,capabilities:['quick-pairing','timeout-barrier','native-visual','native-design','auto-pair-prompt','retained-preview','native-vectors']}));
  if(localPrompt)app.addHook('onClose',async()=>{localPrompt.close();});
  if(quickPairing){
    app.post('/v1/pair/start',async(req)=>{z.object({}).strict().parse(req.body);return localPrompt?localPrompt.start():quickPairing.start();});
    app.post('/v1/pair/poll',async(req)=>{const p=z.object({id:z.string().uuid(),secret:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);return quickPairing.poll(p.id,p.secret);});
    app.post('/v1/pair/cancel',async(req)=>{const p=z.object({id:z.string().uuid(),secret:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);if(localPrompt)localPrompt.cancel(p.id,p.secret);else quickPairing.cancelRequest(p.id,p.secret);return {cancelled:true};});
    app.get('/v1/pair/pending',async()=>({pending:quickPairing.pending()}));
    app.post('/v1/pair/approve',async(req,reply)=>{
      const p=z.object({id:z.string().uuid(),code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body);
      const secret=req.headers['x-figma-pair-approval'];if(typeof secret!=='string')return reply.code(401).send({code:'UNAUTHORIZED'});
      quickPairing.approve(p.id,p.code,secret);return {approved:true};
    });
  }
  app.get('/v1/audit/status',async(req)=>{
    const query=z.object({cursor:z.coerce.number().int().min(0).max(5000).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().parse(req.query);
    const connectionDiagnostics=[...diagnostics.values()].slice(-20);
    const sessionActivity=sessions.activity();
    return audit?{enabled:true,...audit.status(),healthy:!auditFailure&&audit.status().healthy,unresolved:audit.unresolved(query.cursor,query.limit),connectionDiagnostics,sessionActivity}:{enabled:false,healthy:false,connectionDiagnostics,sessionActivity};
  });
  app.post('/v1/ping', async req => { const p = PingInput.parse(req.body); return sessions.request(p.sessionId, p.requestId); });
  app.post('/v1/request', async req => {
    const p=OperationInput.parse(req.body),session=getSession(p.sessionId);if(!session)throw Error('OFFLINE');
    const isWrite=isWriteRequest(p.request);
    if(audit&&isWrite){try{await audit.start(session.context,p.request);}catch{auditFailure=true;throw Error('AUDIT_UNAVAILABLE');}}
    try{
      const current=getSession(p.sessionId);if(!current||current.context.page.id!==session.context.page.id)throw Error('OFFLINE');
      return await trackDispatch(p.sessionId,p.request);
    }catch(e){if(audit&&isWrite)try{await audit.uncertain(session.context.instanceId,p.request.requestId);}catch{auditFailure=true;}throw e;}
  });
  app.post('/v1/preview', async req => {
    const p=z.object({sessionId:z.string().min(1).max(128),params:PreviewInput}).strict().parse(req.body);
    // Requests are generated once, ensuring IDs always match their envelopes.
    const send = (message: Omit<Extract<Request,{method:'export_preview'}>,'requestId'> | Omit<Extract<Request,{method:'preview_chunk'}>,'requestId'>) => { const request={...message,requestId:randomUUID()} as Request;return trackDispatch(p.sessionId,request); };
    const deadline=Date.now()+60000;
    const exported=await send({type:'request',method:'export_preview',params:p.params});
    if(!exported.ok)throw new Error(['NATIVE_NODE_TIMEOUT','NATIVE_EXPORT_TIMEOUT','PREVIEW_NATIVE_BUSY','PREVIEW_PENDING','PREVIEW_INVALIDATED','PAGE_CHANGED'].includes(exported.error.message)?exported.error.message:exported.error.code);
    const meta=PreviewMeta.parse(exported.data),chunks:Buffer[]=[];if(meta.nodeId!==p.params.nodeId)throw new Error('INVALID_PREVIEW_NODE');
    for(let index=0;index<meta.chunks;index++){
      if(Date.now()>deadline)throw new Error('PREVIEW_TIMEOUT');
      const result=await send({type:'request',method:'preview_chunk',params:{exportId:meta.exportId,index}});
      if(!result.ok)throw new Error(result.error.code);
      const chunk=PreviewChunk.parse(result.data);if(chunk.exportId!==meta.exportId||chunk.index!==index)throw new Error('INVALID_CHUNK');
      const bytes=Buffer.from(chunk.base64,'base64');if(bytes.length>36000||bytes.toString('base64')!==chunk.base64)throw new Error('INVALID_CHUNK');chunks.push(bytes);
    }
    const bytes=Buffer.concat(chunks);if(bytes.length!==meta.totalBytes)throw new Error('INVALID_PREVIEW_LENGTH');
    return previews.save(bytes);
  });
  app.get<{Params:{id:string}}>('/v1/previews/:id',async(req,reply)=>{const id=z.string().uuid().parse(req.params.id);return reply.type('image/png').header('Cache-Control','no-store').send(await previews.read(id));});
  app.post('/v1/connect', async (req, reply) => {
    const p = Hello.parse(req.body);
    if (!valid(p.token)) return reply.code(401).send({ code: 'UNAUTHORIZED' });
    let id = '';
    const queue: Request[] = [];
    id = sessions.connect(p.context, 'http', r => queue.push(r), () => polls.delete(id));
    polls.set(id, queue);
    return welcome(id);
  });
  app.get<{ Params: { id: string } }>('/v1/poll/:id', async req => {
    if (!sessions.has(req.params.id, 'http')) throw new Error('OFFLINE');
    sessions.heartbeat(req.params.id);
    return { requests: polls.get(req.params.id)!.splice(0) };
  });
  app.post<{ Params: { id: string } }>('/v1/message/:id', async req => {
    if (!sessions.has(req.params.id, 'http')) throw new Error('OFFLINE');
    const p = ClientMessage.parse(req.body);
    if (p.type === 'hello') throw new Error('INVALID_REQUEST');
    sessions.heartbeat(req.params.id, p.type === 'heartbeat' ? p.context : undefined);
    if (p.type === 'result') await receiveResult(req.params.id, p);
    else if(p.type==='progress')receiveProgress(req.params.id,p);
    return { type: 'ack' };
  });
  app.delete<{ Params: { id: string } }>('/v1/session/:id', async req => {
    if (!sessions.has(req.params.id, 'http')) throw new Error('OFFLINE');
    sessions.disconnect(req.params.id); return { type: 'ack' };
  });
  app.get('/v1/ws', { websocket: true }, (socket) => {
    let id: string | undefined;
    let awaitingPong:Buffer|undefined;
    // Native browser WebSocket pongs do not depend on plugin UI JS timers.
    // They establish transport liveness only, never update page/permission context.
    const transportTimer=setInterval(()=>{
      if(!id)return;
      if(!sessions.has(id,'ws')){socket.close(1000,'Session ended');return;}
      if(awaitingPong)return;
      awaitingPong=Buffer.from(randomUUID());
      try{socket.ping(awaitingPong,false,(error)=>{if(error&&id)sessions.disconnect(id);});}catch{sessions.disconnect(id);}
    },wsHeartbeatMs);
    socket.on('pong',data=>{
      if(!id||!awaitingPong||!awaitingPong.equals(data))return;
      awaitingPong=undefined;try{sessions.heartbeat(id);}catch{socket.close(1000,'Session ended');}
    });
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 3000);
    socket.on('message', raw => {
      try {
        const p = ClientMessage.parse(JSON.parse(raw.toString()));
        if (!id) {
          if (p.type !== 'hello' || !valid(p.token)) { socket.close(1008, 'Unauthorized'); return; }
          id = sessions.connect(p.context, 'ws', r => socket.send(JSON.stringify(r)), () => socket.close(1000, 'Session ended'));
          clearTimeout(authTimer); socket.send(JSON.stringify(welcome(id))); return;
        }
        if (p.type === 'hello' || !sessions.has(id, 'ws')) throw new Error('INVALID_REQUEST');
        sessions.heartbeat(id, p.type === 'heartbeat' ? Heartbeat.parse(p).context : undefined);
        if (p.type === 'result') void receiveResult(id,Result.parse(p)).catch(()=>{socket.close(1008,'Invalid result');});
        else if(p.type==='progress')receiveProgress(id,p);
        else socket.send(JSON.stringify({ type: 'ack' }));
      } catch { socket.close(1008, 'Invalid protocol message'); }
    });
    socket.on('close', () => { clearTimeout(authTimer);clearInterval(transportTimer); if (id) sessions.disconnect(id); });
    socket.on('error', () => {clearInterval(transportTimer); if (id) sessions.disconnect(id); });
  });
  const timer = setInterval(() => sessions.expire(), 1000);
  app.addHook('preClose', async () => { clearInterval(timer); sessions.close();await audit?.flush(); });
  return app;
}
