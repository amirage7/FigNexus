import { randomUUID } from 'node:crypto';
import { VERSION,isWriteRequest, type FileContext, type Request, type Result } from '@bridge/protocol';
type Job = { message: Request; promise: Promise<Result>; resolve: (r: Result) => void; reject: (e: Error) => void; timedOut?: boolean; timer?: ReturnType<typeof setTimeout> };
type Session = { sessionId: string; transport: 'ws' | 'http'; context: FileContext; lastSeen: number; send: (r: Request) => void; jobs: Map<string, Job>; queue: Job[]; active?: Job; cache: Map<string, Result>; fingerprints: Map<string, string>; close: () => void };
export class Sessions {
  private sessions = new Map<string, Session>();
  constructor(readonly leaseMs = 10_000, readonly timeoutMs = 5_000) {}
  connect(context: FileContext, transport: 'ws' | 'http', send: (r: Request) => void, close = () => {}) {
    for (const s of this.sessions.values()) if (s.context.instanceId === context.instanceId) this.disconnect(s.sessionId);
    if (this.sessions.size >= 16) throw new Error('CAPACITY');
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { sessionId, context, transport, send, close, lastSeen: Date.now(), jobs: new Map(), queue: [], cache: new Map(), fingerprints: new Map() });
    return sessionId;
  }
  heartbeat(id: string, context?: FileContext) {
    const s = this.sessions.get(id);
    if (!s || (context && context.instanceId !== s.context.instanceId)) throw new Error('OFFLINE');
    s.lastSeen = Date.now();
    if (context) s.context = context;
  }
  has(id: string, transport?: 'ws' | 'http') {
    this.expire();
    const s = this.sessions.get(id);
    return !!s && (!transport || s.transport === transport);
  }
  status() {
    this.expire();
    return { version: VERSION, online: this.sessions.size > 0, permissions: [...new Set(['read', ...[...this.sessions.values()].filter(s => s.context.writeEnabled).map(() => 'create')])],
      sessions: [...this.sessions.values()].map(({ sessionId, context, transport, lastSeen }) => ({ sessionId, context, transport, lastSeen })) };
  }
  activity(){return [...this.sessions.values()].map(s=>({sessionId:s.sessionId,instanceId:s.context.instanceId,queued:s.queue.length,...(s.active?{active:{requestId:s.active.message.requestId,method:s.active.message.method,timedOut:!!s.active.timedOut}}:{})}));}
  request(id: string, requestId: string, message: Request = { type: 'request', requestId, method: 'ping' }): Promise<Result> {
    this.expire();
    const s = this.sessions.get(id);
    if (!s) return Promise.reject(new Error('OFFLINE'));
    if (message.requestId !== requestId) return Promise.reject(new Error('INVALID_REQUEST'));
    const fingerprint = JSON.stringify(message);
    if (s.fingerprints.has(requestId) && s.fingerprints.get(requestId) !== fingerprint) return Promise.reject(new Error('IDEMPOTENCY_CONFLICT'));
    const cached = s.cache.get(requestId);
    if (cached) return Promise.resolve(cached);
    const existing = s.jobs.get(requestId);
    if (existing) return existing.promise;
    if (s.jobs.size >= 32) return Promise.reject(new Error('QUEUE_FULL'));
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
    s.fingerprints.set(requestId, fingerprint);
    const job: Job = { message, promise, resolve, reject };
    job.timer = setTimeout(() => {
      job.reject(new Error('TIMEOUT'));
      // A request deadline does not prove transport death. Keep the serial
      // barrier and fingerprint until the late result or actual disconnect.
      if (s.active === job) job.timedOut = true;
      else { s.jobs.delete(requestId); s.fingerprints.delete(requestId); s.queue = s.queue.filter(item => item !== job); }
    }, isWriteRequest(message)||message.method==='export_preview' ? Math.max(this.timeoutMs, 20000) : this.timeoutMs);
    s.jobs.set(requestId, job); s.queue.push(job); this.pump(s);
    return promise;
  }
  private pump(s: Session) {
    if (s.active || !this.sessions.has(s.sessionId)) return;
    const job = s.queue.shift();
    if (!job) return;
    s.active = job;
    try { s.send(job.message); } catch { this.disconnect(s.sessionId); }
  }
  respond(id: string, result: Result) {
    const s = this.sessions.get(id), job = s?.active;
    if (!s || !job || job.message.requestId !== result.requestId) return;
    clearTimeout(job.timer); s.jobs.delete(result.requestId); s.active = undefined;
    if (!result.ok && result.error.code === 'CONFIRMATION_REQUIRED') s.fingerprints.delete(result.requestId);
    else s.cache.set(result.requestId, result);
    if (s.cache.size > 128) { const oldest = s.cache.keys().next().value!; s.cache.delete(oldest); s.fingerprints.delete(oldest); }
    if (result.ok && 'context' in result.data && result.data.context?.instanceId === s.context.instanceId) s.context = result.data.context;
    job.resolve(result); this.pump(s);
  }
  disconnect(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    for (const job of s.jobs.values()) { clearTimeout(job.timer); job.reject(new Error('OFFLINE')); }
    s.jobs.clear(); s.queue.length = 0; s.close();
  }
  expire(now = Date.now()) { for (const s of this.sessions.values()) if (now - s.lastSeen > this.leaseMs) this.disconnect(s.sessionId); }
  close() { for (const id of this.sessions.keys()) this.disconnect(id); }
}
