import { expect, it, vi } from 'vitest';
import { createBridge } from '../apps/bridge-server/src/server';
import { PluginConnection } from '../apps/figma-plugin/src/connection';
const token = 'c'.repeat(64);
const context = { instanceId: 'plugin-ui-test', document: { id: '0:0', name: 'Test' }, page: { id: '0:1', name: 'Page' } };
it.each(['ws', 'http'] as const)('plugin UI connection controller round-trips via %s', async (mode: 'ws' | 'http') => {
  const app = await createBridge(token);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  let client: PluginConnection;
  client = new PluginConnection(() => context, r => { void client.send({ type: 'result', requestId: r.requestId, ok: true, data: { pong: true, context } }); }, () => {}, url);
  try {
    await client.connect(token, mode);
    const headers = { authorization: `Bearer ${token}` };
    const status = (await app.inject({ url: '/v1/status', headers })).json();
    expect(status.online).toBe(true);
    const response = await app.inject({ method: 'POST', url: '/v1/ping', headers, payload: { sessionId: status.sessions[0].sessionId, requestId: 'ui-ping' } });
    expect(response.json().data.context).toEqual(context);
  } finally { await client.disconnect(); await app.close(); }
  expect(client.sessionId).toBeUndefined();
});
it('an old rejected connection cannot disconnect a newer connection', async () => {
  let rejectOld!: (e: Error) => void;
  let connects = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/v1/connect')) {
      if (++connects === 1) return new Promise((_resolve, reject) => { rejectOld = reject; });
      return Promise.resolve(Response.json({ type: 'welcome', version: 1, sessionId: 'new', heartbeatMs: 3000, leaseMs: 10000 }));
    }
    return Promise.resolve(Response.json({ type: 'ack' }));
  }));
  const c = new PluginConnection(() => context, () => {}, () => {});
  try {
    const old = c.connect(token, 'http').catch(() => {});
    await vi.waitFor(() => expect(connects).toBe(1));
    await c.connect(token, 'http');
    rejectOld(new Error('old request failed')); await old;
    expect(c.sessionId).toBe('new');
  } finally { await c.disconnect(); vi.unstubAllGlobals(); }
});
it('cleans up a late HTTP welcome after connection cancellation', async () => {
  let resolveOld!: (r: Response) => void;
  let started = false;
  const deleted: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith('/v1/connect')) { started = true; return new Promise(resolve => { resolveOld = resolve; }); }
    if (init.method === 'DELETE') deleted.push(url);
    return Promise.resolve(Response.json({ type: 'ack' }));
  }));
  const c = new PluginConnection(() => context, () => {}, () => {});
  try {
    const old = c.connect(token, 'http');
    await vi.waitFor(() => expect(started).toBe(true));
    await c.disconnect();
    resolveOld(Response.json({ type: 'welcome', version: 1, sessionId: 'late', heartbeatMs: 3000, leaseMs: 10000 }));
    await old;
    expect(deleted).toContain('http://localhost:3055/v1/session/late');
  } finally { await c.disconnect(); vi.unstubAllGlobals(); }
});
it('disconnect cancels a connect waiting for old HTTP session deletion', async () => {
  let releaseDelete!: (r: Response) => void;
  let connectCount = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/v1/connect')) { connectCount++; return Promise.resolve(Response.json({ type: 'welcome', version: 1, sessionId: 'session', heartbeatMs: 3000, leaseMs: 10000 })); }
    return new Promise(resolve => { releaseDelete = resolve; });
  }));
  const c = new PluginConnection(() => context, () => {}, () => {});
  try {
    await c.connect(token, 'http');
    const reconnect = c.connect(token, 'http');
    await vi.waitFor(() => expect(releaseDelete).toBeTypeOf('function'));
    await c.disconnect();
    releaseDelete(Response.json({ type: 'ack' })); await reconnect;
    expect(connectCount).toBe(1); expect(c.sessionId).toBeUndefined();
  } finally { vi.unstubAllGlobals(); await c.disconnect(); }
});
it('a late disconnect cannot erase a newer pairing token', async () => {
  let releaseDelete!: (r: Response) => void;
  let lastAuthorization = '';
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (init.method === 'DELETE') return new Promise(resolve => { releaseDelete = resolve; });
    lastAuthorization = (init.headers as Record<string,string>).Authorization;
    return Promise.resolve(Response.json(url.endsWith('/v1/connect') ? { type: 'welcome', version: 1, sessionId: 'session', heartbeatMs: 3000, leaseMs: 10000 } : { type: 'ack' }));
  }));
  const c = new PluginConnection(() => context, () => {}, () => {});
  try {
    await c.connect(token, 'http');
    const disconnect = c.disconnect();
    await vi.waitFor(() => expect(releaseDelete).toBeTypeOf('function'));
    await c.connect('d'.repeat(64), 'http');
    releaseDelete(Response.json({ type: 'ack' })); await disconnect;
    await c.send({ type: 'result', requestId: 'r', ok: true, data: { pong: true } });
    expect(lastAuthorization).toBe(`Bearer ${'d'.repeat(64)}`);
  } finally { vi.unstubAllGlobals(); await c.disconnect(); }
});
it.each(['ws','http'] as const)('reconnects after Bridge restart via %s', async (mode: 'ws' | 'http') => {
  let app = await createBridge(token);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const c = new PluginConnection(() => context, () => {}, () => {}, url);
  try {
    await c.connect(token, mode);
    const oldId = c.sessionId;
    await app.close();
    app = await createBridge(token);
    await app.listen({ host: '127.0.0.1', port: Number(new URL(url).port) });
    await vi.waitFor(() => { expect(c.sessionId).toBeTruthy(); expect(c.sessionId).not.toBe(oldId); }, { timeout: 7000, interval: 50 });
    const status = (await app.inject({ url: '/v1/status', headers: { authorization: `Bearer ${token}` } })).json();
    expect(status.sessions[0].sessionId).toBe(c.sessionId);
  } finally { await c.disconnect(); await app.close(); }
}, 10000);

