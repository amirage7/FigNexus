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
  async chat(method: 'snapshot' | 'send' | 'stop', message?: { requestId: string; text?: string }) {
    const sessionId = this.sessionId;
    if (!sessionId) throw Error('请先连接本机。');
    const gen = this.generation;
    const path = method === 'snapshot' ? '/v1/chat/' + sessionId : '/v1/chat/' + method;
    const body = method === 'snapshot' ? undefined : {
      sessionId, ...message, ...(method === 'send' ? { pageId: this.context().page.id } : {}),
    };
    const response = await fetch(this.url + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(4000),
    });
    if (gen !== this.generation) throw Error('连接已切换，请重试。');
    if (response.status === 404) throw Error('请更新并重启本机 Bridge。');
    const data = await response.json();
    if (!response.ok) {
      if (data.code === 'CHAT_BUSY') throw Error('有对话正在运行，请稍后重试。');
      if (data.code === 'PAGE_CHANGED') throw Error('页面刚切换，请稍后重试。');
      throw Error('本机对话请求失败，请检查连接后重试。');
    }
    return data;
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
        let accepted = false;
        const timeout = setTimeout(() => { ws.close(); reject(new Error('WebSocket 连接超时')); }, 4000);
        ws.onopen = () => { if (gen === this.generation) ws.send(JSON.stringify(hello)); else ws.close(); };
        ws.onmessage = event => {
          if (gen !== this.generation) return;
          try {
            const message = ServerMessage.parse(JSON.parse(String(event.data)));
            if (message.type === 'welcome') { accepted = true; this.sessionId = message.sessionId; clearTimeout(timeout); resolve(); }
            else if (message.type === 'request') this.request(message);
            else if (message.type === 'error') throw new Error(message.code);
          } catch { ws.close(1008, 'Invalid message'); }
        };
        const closed = () => {
          clearTimeout(timeout);
          if (accepted) this.lost(gen);
          else reject(new Error('WebSocket 未能连接本机 Bridge。'));
        };
        ws.onerror = closed;
        ws.onclose = closed;
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
    this.retry = this.wanted ? setTimeout(() => this.retryNow(), 2000) : undefined;
  }
  private retryNow() {
    if (!this.wanted || this.retry === undefined) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    void this.attempt().catch(() => {});
  }
  resume() {
    if (this.sessionId) void this.tick(this.generation);
    else this.retryNow();
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
    this.retry = undefined;
    this.busy = false;
    const gen = this.generation;
    const id = this.sessionId; this.sessionId = undefined;
    this.socket?.close(); this.socket = undefined;
    if (id && this.mode === 'http') { try { await this.http(`/v1/session/${id}`, 'DELETE'); } catch {} }
    if (gen === this.generation) this.state('已断开');
  }
}
