import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { codexAppServer } from '../apps/bridge-server/src/codex-app-server';

const fakeAppServer = String.raw`
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
const threadId = 'test-thread', turnId = 'test-turn';
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let timer;
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method === 'initialize') reply({});
  if (method === 'account/read') reply({ account: null, requiresOpenaiAuth: false });
  if (method === 'thread/start' || method === 'thread/resume') reply({ thread: { id: threadId } });
  if (method === 'turn/start') {
    reply({ turn: { id: turnId } });
    notify('item/agentMessage/delta', { itemId: 'preamble', delta: 'Started' });
    const mode = params.input[0].text.split('\n\n').at(-1);
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

async function run(mode: string, onText: (delta: string) => void = () => {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'fignexus-app-server-'));
  try {
    await writeFile(join(cwd, 'app-server'), fakeAppServer);
    const driver = codexAppServer(process.execPath, 'unused-mcp', cwd, { startupMs: 3000, idleMs: 500 });
    const context = { instanceId: 'test', document: { id: '0', name: 'Test' }, page: { id: '1', name: 'Page' } };
    return await driver({ text: mode, target: { sessionId: 'test-session', context }, scope: 'test',
      signal: new AbortController().signal }, { thread: async () => {}, text: onText });
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
