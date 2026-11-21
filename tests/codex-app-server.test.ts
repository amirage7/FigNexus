import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { codexAppServer } from '../apps/bridge-server/src/codex-app-server';

const fakeAppServer = String.raw`
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
let threadId = 'test-thread';
const turnId = 'test-turn';
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let timer;
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method === 'initialize') reply({});
  if (method === 'account/read') reply({ account: null, requiresOpenaiAuth: false });
  if (method === 'thread/start') reply({ thread: { id: threadId } });
  if (method === 'thread/resume') send({ id, error: { code: -32600, message: params.threadId === 'locked-thread'
    ? 'thread locked-thread already has an active writer' : 'thread not found' } });
  if (method === 'thread/fork' && params.threadId === 'locked-thread') {
    threadId = 'forked-thread';
    reply({ thread: { id: threadId, forkedFromId: 'locked-thread' } });
  }
  if (method === 'turn/start') {
    reply({ turn: { id: turnId } });
    notify('item/agentMessage/delta', { itemId: 'preamble', delta: 'Started' });
    const mode = params.input[0].text.split('\n\n').at(-1);
    if (mode === 'locked' && params.threadId === 'forked-thread') {
      notify('item/agentMessage/delta', { itemId: 'final', delta: 'Recovered' });
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }
    if (mode === 'limit') notify('turn/completed', { turn: { id: turnId, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } });
    if (mode === 'active') {
      let count = 0;
      timer = setInterval(() => {
        notify('item/completed', { item: { id: 'tool-' + count, type: 'mcpToolCall' } });
        if (++count === 8) {
          clearInterval(timer);
          notify('item/agentMessage/delta', { itemId: 'final', delta: 'Done' });
          notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
        }
      }, 125);
    }
  }
  if (method === 'turn/interrupt') {
    clearInterval(timer);
    reply({});
    notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  }
});
lines.on('close', () => clearInterval(timer));
`;

async function run(mode: string, onText: (delta: string) => void = () => {}, source?: {
  id: string; save: (id: string, notice?: string) => Promise<void>;
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'fignexus-app-server-'));
  try {
    await writeFile(join(cwd, 'app-server'), fakeAppServer);
    const driver = codexAppServer(process.execPath, 'unused-mcp', cwd, { startupMs: 3000, idleMs: 500 });
    const context = { instanceId: 'test', document: { id: '0', name: 'Test' }, page: { id: '1', name: 'Page' } };
    return await driver({ text: mode, threadId: source?.id, target: { sessionId: 'test-session', context }, scope: 'test',
      signal: new AbortController().signal }, { thread: source?.save ?? (async () => {}), text: onText });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

it('keeps working past the idle interval while FigNexus tool events are arriving', async () => {
  let text = '';
  await expect(run('active', delta => { text += delta; })).resolves.toBe('completed');
  expect(text).toBe('Started\n\nDone');
});

it('reports a stalled turn distinctly and retains text it already streamed', async () => {
  let text = '';
  await expect(run('stuck', delta => { text += delta; })).rejects.toThrow('长时间没有进展');
  expect(text).toBe('Started');
});

it('uses the terminal App Server error category when a limit really is reached', async () => {
  await expect(run('limit')).rejects.toThrow('已达到 Codex 用量上限');
});

it('continues a writer-locked conversation from stored history in a new thread', async () => {
  const saved: Array<{ id: string; notice?: string }> = [];
  let text = '';
  const result = run('locked', delta => { text += delta; }, {
    id: 'locked-thread', save: async (id, notice) => { saved.push({ id, notice }); },
  });
  await expect(result).resolves.toBe('completed');
  expect(text).toBe('Started\n\nRecovered');
  expect(saved).toEqual([{ id: 'forked-thread', notice: expect.stringContaining('从已有记录继续') }]);
});

it('does not fork when resume fails for a different reason', async () => {
  await expect(run('missing', undefined, {
    id: 'missing-thread', save: async () => { throw Error('Should not save a replacement'); },
  })).rejects.toThrow('无法恢复这段 Codex 会话');
});
