import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { PluginConnection } from './connection';

const Snapshot = z.object({
  canStop: z.boolean(),
  turns: z.array(z.object({
    id: z.string(), text: z.string(), reply: z.string(),
    status: z.enum(['running', 'completed', 'interrupted', 'failed']),
    error: z.string().optional(), notice: z.string().optional(),
  })).max(20),
});

function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function CodexChatPanel({ connection, persistent }: { connection: PluginConnection; persistent: boolean }) {
  const [draft, setDraft] = useState('');
  const [snapshot, setSnapshot] = useState<z.infer<typeof Snapshot>>();
  const [action, setAction] = useState<'sending' | 'stopping'>();
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const attempt = useRef<{ requestId: string; text: string }>(undefined);
  const history = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const lastTurn = snapshot?.turns.at(-1);
  const running = lastTurn?.status === 'running';
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let delay = 1200;
      try {
        const state = Snapshot.parse(await connection.chat('snapshot'));
        if (state.turns.at(-1)?.status === 'running') delay = 400;
        if (live) { setSnapshot(state); setRefreshError(''); }
      } catch (error) {
        if (live) setRefreshError(error instanceof Error ? error.message : '无法读取本机对话。');
      } finally {
        if (live) timer = setTimeout(refresh, delay);
      }
    }
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [connection]);
  useEffect(() => {
    if (follow.current && history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [snapshot]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !snapshot || action || running) return;
    setAction('sending');
    setError('');
    const payload = attempt.current?.text === text ? attempt.current : { requestId: requestId(), text };
    attempt.current = payload;
    try {
      await connection.chat('send', payload);
      attempt.current = undefined;
      setDraft('');
      follow.current = true;
      setSnapshot(Snapshot.parse(await connection.chat('snapshot')));
    } catch (error) {
      setError(error instanceof Error ? error.message : '发送失败。');
    } finally {
      setAction(undefined);
      composer.current?.focus();
    }
  }
  async function stop() {
    if (!lastTurn) return;
    setAction('stopping');
    setError('');
    try { await connection.chat('stop', { requestId: lastTurn.id }); }
    catch (error) { setError(error instanceof Error ? error.message : '停止失败。'); }
    finally { setAction(undefined); }
  }
  const message = error || refreshError || (running ? 'Codex 正在回复…' : !snapshot ? '正在读取对话…' : '');
  return <div className="codex-chat">
    <div className="codex-chat-history" ref={history} aria-label="对话记录" onScroll={event => {
      const area = event.currentTarget;
      follow.current = area.scrollHeight - area.scrollTop - area.clientHeight < 48;
    }}>
      {snapshot?.turns.length === 0 && <div className="codex-chat-empty">
        <h2>从当前画布开始</h2>
        <p>选中图层，让 Codex 检查或修改它。</p>
        {!persistent && <p>当前文件的对话仅保留到插件关闭。</p>}
      </div>}
      {snapshot?.turns.map(turn => <div className="codex-chat-turn" key={turn.id}>
        <p className="codex-chat-user"><span className="visually-hidden">你</span>{turn.text}</p>
        {turn.notice && <p className="codex-chat-status">{turn.notice}</p>}
        {(turn.reply || turn.error || turn.status === 'interrupted') && <p className="codex-chat-reply"><span className="visually-hidden">Codex</span>{turn.reply}
          {turn.status === 'interrupted' && <span className="codex-chat-status">已停止</span>}
          {turn.error && <span className="codex-chat-status">{turn.error}</span>}
        </p>}
      </div>)}
    </div>
    <form className="codex-chat-form" onSubmit={event => { void send(event); }}>
      {message && <p role={error || refreshError ? 'alert' : 'status'} className={'codex-chat-status' + (error || refreshError ? ' chat-error' : '')}>{message}</p>}
      <div className="codex-composer">
        <textarea ref={composer} aria-label="给 Codex 的消息" placeholder="给 Codex 发消息" rows={2} maxLength={8000}
          value={draft} onChange={event => setDraft(event.target.value)} readOnly={action === 'sending'}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            if (snapshot && draft.trim() && !action && !running) event.currentTarget.form?.requestSubmit();
          }} />
        <div className="codex-chat-actions">
          {running ? snapshot?.canStop && <button type="button" className="button" disabled={Boolean(action)} onClick={() => { void stop(); }}>停止</button>
            : <button type="submit" className="button button-primary" title="Enter 发送，Shift+Enter 换行" disabled={!snapshot || !draft.trim() || Boolean(action)}>{action === 'sending' ? '发送中' : '发送'}</button>}
        </div>
      </div>
    </form>
  </div>;
}
