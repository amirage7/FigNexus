import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FileContext } from '@bridge/protocol';

type Target = { sessionId: string; context: FileContext };
type Outcome = 'completed' | 'interrupted' | 'failed';
export type ChatDriver = (input: {
  threadId?: string; text: string; target: Target; scope: string; signal: AbortSignal;
}, events: {
  thread: (id: string) => Promise<void>;
  text: (delta: string) => void;
}) => Promise<Outcome>;

const Turn = z.object({
  id: z.string().uuid(),
  text: z.string().max(8000),
  reply: z.string().max(32000),
  status: z.enum(['running', 'completed', 'interrupted', 'failed']),
  error: z.string().max(300).optional(),
});
const History = z.object({ threadId: z.string().min(1).max(128).optional(), turns: z.array(Turn).max(20) });
type History = z.infer<typeof History>;
type Active = { scope: string; target: Target; abort: AbortController; history: History; done: Promise<void> };

export class CodexChats {
  private active = new Map<string, Active>();
  private scopes = new Map<string, Active>();
  private starting = new Set<string>();
  private closing = false;

  constructor(private directory: string, private driver: ChatDriver) {}

  private path(context: FileContext) {
    const identity = context.fileKey ? `file:${context.fileKey}` : `instance:${context.instanceId}`;
    return join(this.directory, createHash('sha256').update(identity).digest('hex') + '.json');
  }

  private async load(path: string): Promise<History> {
    try {
      const history = History.parse(JSON.parse(await readFile(path, 'utf8')));
      for (const turn of history.turns) {
        if (turn.status === 'running') turn.status = 'interrupted';
      }
      return history;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { turns: [] };
    }
  }

  private async save(path: string, history: History) {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(history), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async snapshot(target: Target) {
    const path = this.path(target.context);
    const active = this.active.get(path);
    const history = active?.history ?? await this.load(path);
    return { turns: history.turns, canStop: active?.target.sessionId === target.sessionId };
  }

  async send(target: Target, id: string, text: string) {
    const path = this.path(target.context);
    const existing = this.active.get(path);
    if (existing?.history.turns.some(turn => turn.id === id && turn.text === text)) return;
    if (this.closing || existing || this.starting.has(path) || this.active.size + this.starting.size >= 4) throw Error('CHAT_BUSY');
    this.starting.add(path);
    try {
      const history = await this.load(path);
      const prior = history.turns.find(turn => turn.id === id);
      if (prior?.text === text) return;
      if (prior) throw Error('CHAT_CONFLICT');
      if (this.closing) throw Error('CHAT_BUSY');
      const turn: z.infer<typeof Turn> = { id, text, reply: '', status: 'running' };
      history.turns = [...history.turns.slice(-19), turn];
      await this.save(path, history);
      if (this.closing) throw Error('CHAT_BUSY');
      const active: Active = {
        scope: randomBytes(32).toString('hex'), target, history,
        abort: new AbortController(), done: Promise.resolve(),
      };
      this.active.set(path, active);
      this.scopes.set(active.scope, active);
      active.done = this.run(path, active, turn);
    } finally {
      this.starting.delete(path);
    }
  }

  private async run(path: string, active: Active, turn: z.infer<typeof Turn>) {
    try {
      turn.status = await this.driver({
        scope: active.scope, target: active.target, signal: active.abort.signal, threadId: active.history.threadId, text: turn.text,
      }, {
        thread: async id => {
          active.history.threadId = id;
          await this.save(path, active.history);
        },
        text: delta => { turn.reply = (turn.reply + delta).slice(0, 32000); },
      });
      if (turn.status === 'failed') turn.error = 'Codex 结束了这一轮。可以在本会话继续。';
    } catch (error) {
      turn.status = active.abort.signal.aborted ? 'interrupted' : 'failed';
      if (turn.status === 'failed') turn.error = error instanceof Error ? error.message.slice(0, 300) : '无法启动 Codex。';
    } finally {
      this.scopes.delete(active.scope);
      const outcome = turn.status;
      turn.status = 'running';
      const final = { ...active.history, turns: active.history.turns.map(item => item === turn ? { ...turn, status: outcome } : item) };
      try { await this.save(path, final); }
      catch {
        turn.error = '无法保存对话记录。请检查本机 Bridge 数据目录。';
        turn.status = 'failed';
        return;
      } finally {
        this.active.delete(path);
      }
      turn.status = outcome;
    }
  }

  scope(token: string) {
    const active = this.scopes.get(token);
    return active?.abort.signal.aborted ? undefined : active?.target;
  }

  stop(target: Target, requestId: string) {
    const active = this.active.get(this.path(target.context));
    if (active?.target.sessionId !== target.sessionId || active.history.turns.at(-1)?.id !== requestId) return;
    active.abort.abort();
  }

  disconnect(sessionId: string) {
    for (const active of this.active.values()) {
      if (active.target.sessionId === sessionId) active.abort.abort();
    }
  }

  async close() {
    this.closing = true;
    for (const active of this.active.values()) active.abort.abort();
    await Promise.allSettled([...this.active.values()].map(active => active.done));
  }
}
