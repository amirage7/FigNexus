import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CodexChats, type ChatDriver } from '../apps/bridge-server/src/codex-chat';
import { createBridge } from '../apps/bridge-server/src/server';

it('streams, confines canvas tools to the originating session, and resumes after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fignexus-chat-'));
  const token = 'a'.repeat(64);
  const headers = { authorization: `Bearer ${token}` };
  let scope = '';
  let finish!: () => void;
  let resumed: string | undefined;
  const driver: ChatDriver = async (input, events) => {
    scope = input.scope;
    resumed = input.threadId;
    await events.thread('stored-thread');
    events.text('你好');
    await new Promise<void>(resolve => {
      finish = resolve;
      input.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return input.signal.aborted ? 'interrupted' : 'completed';
  };
  const open = () => createBridge(token, false, undefined, {}, undefined, undefined, new CodexChats(directory, driver));
  let app = await open();
  const connect = async (fileKey: string, instanceId: string) => (await app.inject({
    method: 'POST', url: '/v1/connect', headers,
    payload: { type: 'hello', version: 1, token, context: { fileKey, instanceId, document: { id: '0:0', name: 'Canvas' }, page: { id: '0:1', name: 'Page' } } },
  })).json().sessionId as string;
  const send = (sessionId: string, requestId: string) => app.inject({
    method: 'POST', url: '/v1/chat/send', headers, payload: { sessionId, requestId, text: 'Hi' },
  });
  const state = async (sessionId: string) => (await app.inject({ url: `/v1/chat/${sessionId}`, headers })).json();
  try {
    const origin = await connect('file-a', 'one');
    const other = await connect('file-b', 'two');
    const requestId = randomUUID();
    expect((await send(origin, requestId)).statusCode).toBe(200);
    expect((await send(origin, requestId)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await state(origin)).turns.at(-1)?.reply).toBe('你好'));
    const scoped = { authorization: `Bearer ${scope}` };
    expect((await app.inject({ url: '/v1/status', headers: scoped })).json().sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([origin]);
    expect((await app.inject({ url: `/v1/chat/${origin}`, headers: scoped })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/request', headers: scoped, payload: { sessionId: other, request: { type: 'request', requestId, method: 'get_selection', params: {} } } })).statusCode).toBe(403);
    const pending = app.inject({ method: 'POST', url: '/v1/request', headers: scoped,
      payload: { sessionId: origin, request: { type: 'request', requestId, method: 'get_selection', params: {} } },
    });
    await vi.waitFor(async () => {
      const { requests } = (await app.inject({ url: '/v1/poll/' + origin, headers })).json();
      expect(requests[0]?.chatPageId).toBe('0:1');
    });
    await app.inject({ method: 'POST', url: '/v1/message/' + origin, headers,
      payload: { type: 'result', requestId, ok: false, error: { code: 'PAGE_CHANGED', message: 'Page changed' } },
    });
    expect((await pending).json().error.code).toBe('PAGE_CHANGED');
    finish();
    await vi.waitFor(async () => expect((await state(origin)).turns.at(-1)?.status).toBe('completed'));
    expect((await app.inject({ url: '/v1/status', headers: scoped })).statusCode).toBe(401);
    await app.close();
    app = await open();
    const reconnected = await connect('file-a', 'three');
    expect((await state(reconnected)).turns).toHaveLength(1);
    const nextId = randomUUID();
    expect((await send(reconnected, nextId)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await state(reconnected)).turns.at(-1)?.reply).toBe('你好'));
    expect(resumed).toBe('stored-thread');
    const stop = (requestId: string) => app.inject({ method: 'POST', url: '/v1/chat/stop', headers, payload: { sessionId: reconnected, requestId } });
    expect((await stop(requestId)).statusCode).toBe(200);
    expect((await state(reconnected)).turns.at(-1)?.status).toBe('running');
    expect((await stop(nextId)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await state(reconnected)).turns.at(-1)?.status).toBe('interrupted'));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
