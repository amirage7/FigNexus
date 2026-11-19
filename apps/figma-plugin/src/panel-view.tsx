import React, { useState } from 'react';
import type { FileContext } from '@bridge/protocol';
import type { LocalDeleteState } from './confirmation-ui';

export type PanelViewProps = {
  compact: boolean;
  status: string;
  file?: FileContext;
  hasPair: boolean;
  savedPair?: boolean;
  remember: boolean;
  waiting: boolean;
  code?: string;
  notices: string[];
  deletion: LocalDeleteState;
  chat?: React.ReactNode;
  canvas?: React.ReactNode;
  actions: {
    toggle: (compact: boolean) => void;
    pair: () => void;
    reconnect: () => void;
    cancel: () => void;
    remember: (enabled: boolean) => void;
    repair: () => void;
    fallback: () => void;
    forget: () => void;
    confirm: (approved: boolean) => void;
  };
};

export function PanelView(p: PanelViewProps) {
  const [view, setView] = useState<'chat' | 'canvas'>('chat');
  const online = p.status.startsWith('在线');
  const connecting = p.status.startsWith('正在连接');
  const connectionLabel = online ? '已连接' : p.waiting ? '配对中' : connecting ? '连接中' : '未连接';
  const confirmation = p.deletion.confirmation;
  const compact = p.compact && !confirmation;
  const pairingRequired = !online && view === 'chat';
  const notices = [...new Set(p.notices.filter(Boolean))];
  const status = <span className={online ? 'connection-status online' : 'connection-status'} role="status">{connectionLabel}</span>;
  return <>
    {compact && <main className="compact-panel">
      {status}
      <button type="button" className="button button-quiet" onClick={() => p.actions.toggle(false)} aria-label="展开插件">展开</button>
    </main>}
    <main className="expanded-panel" hidden={compact}>
      <header className="panel-heading">
        <div className="document-location">
          <strong title={p.file?.document.name}>{p.file?.document.name || 'FigNexus'}</strong>
          {p.file && <span title={p.file.page.name}>{p.file.page.name}</span>}
        </div>
        <div className="panel-controls">
          <details className="connection-settings" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
          }} onKeyDown={event => {
            if (event.key !== 'Escape' || !event.currentTarget.open) return;
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}>
            <summary aria-label={'连接设置 · ' + connectionLabel} title="连接设置">{status}</summary>
            <div className="settings-content">
              <label className="remember-control">
                <input type="checkbox" checked={p.remember} onChange={event => p.actions.remember(event.target.checked)} />
                下次自动连接
              </label>
              <div className="settings-actions">
                {(p.hasPair || p.savedPair) && <button type="button" className="button" disabled={!p.file || p.waiting} onClick={p.actions.repair}>重新配对</button>}
                {p.hasPair && <button type="button" className="button" disabled={!p.file || p.waiting} onClick={p.actions.fallback}>尝试备用连接</button>}
                {(p.hasPair || p.savedPair) && <button type="button" className="button button-danger-text" disabled={p.waiting} onClick={p.actions.forget}>清除本机配对</button>}
              </div>
            </div>
          </details>
          <button type="button" className="button button-quiet" disabled={!!confirmation || p.waiting} onClick={() => p.actions.toggle(true)} aria-label="折叠插件">折叠</button>
        </div>
      </header>

      {confirmation && <section className="confirmation-panel" aria-label="删除确认">
        <h2>删除 {confirmation.targets.length} 个图层？</h2>
        <p className="confirmation-targets">{confirmation.targets.join(', ')}</p>
        <p>修改前会创建备份。</p>
        <div className="connect-actions">
          <button type="button" className="button button-danger" onClick={() => p.actions.confirm(true)}>确认并执行删除</button>
          <button type="button" className="button" onClick={() => p.actions.confirm(false)}>取消</button>
        </div>
      </section>}

      <nav className="workspace-nav" aria-label="插件功能" hidden={Boolean(confirmation)}>
        <button type="button" aria-pressed={view === 'chat'} aria-controls="workspace-chat" onClick={() => setView('chat')}>Codex 对话</button>
        <button type="button" aria-pressed={view === 'canvas'} aria-controls="workspace-canvas" onClick={() => setView('canvas')}>画布工具</button>
      </nav>
      {notices.length > 0 && !pairingRequired && <div className="panel-notices">
        {notices.map(notice => <p key={notice} role="status">{notice}</p>)}
      </div>}

      <section id="workspace-chat" className="workspace-view chat-view" aria-label="Codex 对话" hidden={view !== 'chat' || Boolean(confirmation)}>
        {online ? p.chat : <div className="pairing-view">
          <h2>{p.waiting ? '确认本机配对' : connecting ? '正在连接' : p.hasPair ? '连接已断开' : '连接本机 Codex'}</h2>
          {p.waiting && p.code && <strong className="pairing-code">{p.code}</strong>}
          {notices.length > 0
            ? notices.map(notice => <p key={notice} role="status">{notice}</p>)
            : !connecting && !p.waiting && <p>{p.hasPair ? '重新连接后即可继续对话。' : '配对一次，即可在 Figma 里使用 Codex。'}</p>}
          <div className="connect-actions">
            {p.waiting
              ? <button type="button" className="button" onClick={p.actions.cancel}>取消配对</button>
              : !connecting && <button type="button" className="button button-primary" disabled={!p.file} onClick={p.hasPair ? p.actions.reconnect : p.actions.pair}>{p.hasPair ? '重新连接' : '配对本机'}</button>}
          </div>
        </div>}
      </section>
      <section id="workspace-canvas" className="workspace-view canvas-view" aria-label="画布工具" hidden={view !== 'canvas' || Boolean(confirmation)}>
        {p.canvas}
      </section>
    </main>
  </>;
}
