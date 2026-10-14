import { ServerMessage, Hello, Result, Request, Poll, RequestProgress, type FileContext } from '@bridge/protocol';
export class PluginConnection {
  sessionId?: string;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private intent = 0;
  private wanted = false;
  private token = '';
  private mode: 'ws' | 'http' = 'ws';
  private busy = false;
  constructor(private context: () => FileContext, private request: (r: Request) => void, private state: (s: string) => void, private url = 'http://localhost:3055',private connected:(token:string,mode:'ws'|'http')=>void=()=>{}) {}
  private async http(path: string, method = 'GET', body?: unknown, token = this.token) {
    const r = await fetch(this.url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async connect(token: string, mode: 'ws' | 'http') {
    const intent = ++this.intent;
    await this.stop();
    if (intent !== this.intent) return;
    this.token = token; this.mode = mode; this.wanted = true;
    await this.attempt();
  }
  private async attempt() {
    const pending = this.open(), gen = this.generation;
    try { await pending; }
    catch (e) { if (gen === this.generation) { this.lost(gen); throw e; } }
  }
  private async open() {
    const gen = ++this.generation;
    const token = this.token;
    const hello = Hello.parse({ type: 'hello', version: 1, token, context: this.context() });
    this.state('正在连接…');
    if (this.mode === 'http') {
      const welcome = ServerMessage.parse(await this.http('/v1/connect', 'POST', hello, token));
      if (welcome.type !== 'welcome') throw new Error('Invalid welcome');
      if (gen !== this.generation) {
        try { await this.http(`/v1/session/${welcome.sessionId}`, 'DELETE', undefined, token); } catch {}
        return;
      }
      this.sessionId = welcome.sessionId;
    } else {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(this.url.replace('http:', 'ws:') + '/v1/ws');
        this.socket = ws;
        const timeout = setTimeout(() => { ws.close(); reject(new Error('WebSocket 连接超时')); }, 4000);
        ws.onopen = () => { if (gen === this.generation) ws.send(JSON.stringify(hello)); else ws.close(); };
        ws.onmessage = event => {
          if (gen !== this.generation) return;
          try {
            const message = ServerMessage.parse(JSON.parse(String(event.data)));
            if (message.type === 'welcome') { this.sessionId = message.sessionId; clearTimeout(timeout); resolve(); }
            else if (message.type === 'request') this.request(message);
            else if (message.type === 'error') throw new Error(message.code);
          } catch { ws.close(1008, 'Invalid message'); }
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket 失败：检查 Bridge、网络权限，或选择 HTTP 轮询')); };
        ws.onclose = () => { clearTimeout(timeout); reject(new Error('WebSocket 已断开')); this.lost(gen); };
      });
    }
    if (gen !== this.generation || !this.wanted) return;
    this.state(`在线 · ${this.mode} · ${this.sessionId}`);
    this.connected(this.token,this.mode);
    this.timer = setInterval(() => { void this.tick(gen); }, this.mode === 'ws' ? 3000 : 1000);
  }
  private async tick(gen: number) {
    if (gen !== this.generation || this.busy || !this.sessionId) return;
    this.busy = true;
    try {
      const message = { type: 'heartbeat', context: this.context() };
      if (this.mode === 'ws') {
        // Timer delays do not prove transport failure. Bridge native ping/pong
        // checks transport liveness independently; close/error triggers reconnect.
        this.socket!.send(JSON.stringify(message));
      } else {
        const id = this.sessionId;
        await this.http(`/v1/message/${id}`, 'POST', message);
        const poll = Poll.parse(await this.http(`/v1/poll/${id}`));
        if (gen !== this.generation) return;
        for (const r of poll.requests) this.request(Request.parse(r));
      }
    } catch { this.lost(gen); }
    finally { if (gen === this.generation) this.busy = false; }
  }
  private lost(gen: number) {
    if (gen !== this.generation) return;
    ++this.generation; this.sessionId = undefined; this.busy = false;
    clearInterval(this.timer); this.socket?.close(); this.socket = undefined;
    this.state('离线 · 2 秒后重连（可点击断开停止）');
    clearTimeout(this.retry);
    if (this.wanted) this.retry = setTimeout(() => { void this.attempt().catch(() => {}); }, 2000);
  }
  async send(result: Result) {
    const p = Result.parse(result);
    return this.sendMessage(p);
  }
  async progress(message:RequestProgress){return this.sendMessage(RequestProgress.parse(message));}
  private async sendMessage(p:Result|RequestProgress){
    const gen = this.generation;
    if (!this.sessionId) return;
    try {
      if (this.mode === 'ws') this.socket!.send(JSON.stringify(p));
      else await this.http(`/v1/message/${this.sessionId}`, 'POST', p);
    } catch { this.lost(gen); }
  }
  async disconnect() {
    const intent = ++this.intent;
    await this.stop();
    if (intent === this.intent) this.token = '';
  }
  private async stop() {
    this.wanted = false; ++this.generation; clearInterval(this.timer); clearTimeout(this.retry);
    const gen = this.generation;
    const id = this.sessionId; this.sessionId = undefined;
    this.socket?.close(); this.socket = undefined;
    if (id && this.mode === 'http') { try { await this.http(`/v1/session/${id}`, 'DELETE'); } catch {} }
    if (gen === this.generation) this.state('已断开');
  }
}
