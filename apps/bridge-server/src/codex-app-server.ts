import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { ChatDriver } from './codex-chat';

type ServerEvent = {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: {
    threadId?: string; turnId?: string; itemId?: string; delta?: string;
    item?: { id: string; type: string; text?: string };
    turn?: { id?: string; status: 'completed' | 'interrupted' | 'failed'; error?: { codexErrorInfo?: unknown } };
    error?: { codexErrorInfo?: unknown };
    willRetry?: boolean;
  };
};

type TurnResult = { status: 'completed' | 'interrupted' | 'failed'; error?: Error };

function describeTurnFailure(info: unknown) {
  const category = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  switch (category) {
    case 'usageLimitExceeded': return '已达到 Codex 用量上限。额度恢复后，可以在本会话继续。';
    case 'contextWindowExceeded': return '这段 Codex 对话已超过上下文上限。';
    case 'unauthorized': return 'Codex 登录已失效。重新登录后，可以在本会话继续。';
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected': return 'Codex 与模型服务的连接中断。可以在本会话继续。';
    default: return 'Codex 结束了这一轮，未返回具体原因。可以在本会话继续。';
  }
}

const readTools = ['figma_get_status', 'figma_get_selection', 'figma_get_nodes', 'figma_find_nodes', 'figma_get_document'];
const editTools = ['figma_update_node', 'figma_update_text', 'figma_edit_nodes'];
const quote = (value: string) => JSON.stringify(value);
const Account = z.object({ account: z.unknown().nullable(), requiresOpenaiAuth: z.boolean() });
const Thread = z.object({ thread: z.object({ id: z.string().min(1) }) });
const Turn = z.object({ turn: z.object({ id: z.string().min(1) }) });
const RpcFailure = z.object({ code: z.number(), message: z.string() });
const rpcErrors: Record<string, string> = {
  initialize: '无法初始化本机 Codex。可以重试。',
  'account/read': '无法读取本机 Codex 登录状态。',
  'thread/start': '无法创建 Codex 会话。请检查本机 FigNexus 工具连接。',
  'thread/resume': '无法恢复这段 Codex 会话。请检查原会话和本机 FigNexus 工具连接。',
  'thread/fork': '原 Codex 会话正在被占用，暂时无法从已有记录继续。请稍后重试。',
  'turn/start': 'Codex 未能开始这条消息。可以在本会话重试。',
};

class CodexRpcError extends Error {
  readonly activeWriter: boolean;

  constructor(method: string, error: unknown) {
    super(rpcErrors[method] ?? '本机 Codex 未能处理请求。');
    const details = RpcFailure.safeParse(error);
    this.activeWriter = method === 'thread/resume' && details.success && details.data.code === -32600
      && details.data.message.includes('already has an active writer');
  }
}

export function codexAppServer(
  command: string, mcpEntry: string, cwd: string,
  { startupMs = 90_000, idleMs = 300_000 } = {},
): ChatDriver {
  return async (input, events) => {
    await mkdir(cwd, { recursive: true });
    if (input.signal.aborted) return 'interrupted';
    const env = { ...process.env, FIGMA_CHAT_SCOPE: input.scope };
    for (const key of ['FIGMA_BRIDGE_TOKEN_FILE', 'FIGMA_BRIDGE_DATA_DIR', 'FIGMA_BRIDGE_AUDIT_DIR', 'FIGMA_BRIDGE_PAIR_APPROVAL_FILE']) Reflect.deleteProperty(env, key);
    const mcp = [
      'command=' + quote(process.execPath),
      'args=[' + quote(mcpEntry) + ']',
      'env_vars=["FIGMA_CHAT_SCOPE"]',
      'required=true',
      'enabled_tools=[' + [...readTools, ...editTools].map(quote).join(', ') + ']',
      // Codex otherwise omits tools that would require an unavailable approval.
      // FigNexus still enforces the current canvas scope and native delete confirmation.
      'tools={' + editTools.map(name => name + '={approval_mode="approve"}').join(', ') + '}',
    ].join(', ');
    const child = spawn(command, [
      'app-server', '--listen', 'stdio://',
      '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '--disable', 'memories',
      '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'multi_agent_v2',
      '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'mcp_servers={figma-ai-bridge={' + mcp + '}}',
    ], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let sequence = 0;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let lastItem: string | undefined;
    let reportedError: unknown;
    let idleFailure: Error | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const streamed = new Set<string>();
    let complete!: (result: TurnResult) => void;
    const completed = new Promise<TurnResult>(resolve => { complete = resolve; });
    const failed = (error: Error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      complete(input.signal.aborted ? { status: 'interrupted' } : { status: 'failed', error });
    };
    child.on('error', error => failed(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? '找不到 Codex。请安装 Codex 并确认 codex 命令可用。' : '无法启动本机 Codex。')));
    child.on('close', () => failed(new Error('本机 Codex 进程已退出。可以在本会话继续。')));
    child.stdin.on('error', () => failed(new Error('本机 Codex 连接已关闭。')));
    const send = (message: unknown) => { child.stdin.write(JSON.stringify(message) + '\n'); };
    const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { method, resolve, reject });
      send({ id, method, params });
    });
    const append = (itemId: string, text: string) => {
      if (lastItem && lastItem !== itemId) events.text('\n\n');
      lastItem = itemId;
      streamed.add(itemId);
      events.text(text);
    };
    lines.on('line', line => {
      let message: ServerEvent;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: 'Interactive Codex approvals are unavailable in FigNexus.' } });
        return;
      }
      if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (!request) return;
        if (message.error) request.reject(new CodexRpcError(request.method, message.error));
        else request.resolve(message.result);
        return;
      }
      const p = message.params;
      const incomingTurn = p?.turnId ?? p?.turn?.id;
      if (!p || !threadId || p.threadId !== threadId || (turnId && incomingTurn && incomingTurn !== turnId)) return;
      if (message.method === 'error' && !p.willRetry) reportedError = p.error?.codexErrorInfo;
      if (message.method === 'turn/completed' && p.turn) {
        const { status, error } = p.turn;
        complete({ status, error: status === 'failed' ? new Error(describeTurnFailure(error?.codexErrorInfo ?? reportedError)) : undefined });
        return;
      }
      // Tool work, reasoning and token usage can progress between visible text chunks.
      if (turnId && (message.method?.startsWith('item/') || message.method?.startsWith('turn/') ||
          message.method === 'thread/tokenUsage/updated' || (message.method === 'error' && p.willRetry))) armIdleTimer();
      if (message.method === 'item/agentMessage/delta' && p.itemId && p.delta) append(p.itemId, p.delta);
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text && !streamed.has(p.item.id)) append(p.item.id, p.item.text);
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const interrupt = () => {
      if (!threadId || !turnId) { child.kill(); return; }
      if (killTimer) return;
      killTimer = setTimeout(() => child.kill(), 4000);
      void rpc('turn/interrupt', { threadId, turnId }).catch(() => child.kill());
    };
    const armIdleTimer = () => {
      if (idleFailure || input.signal.aborted) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFailure = new Error('Codex 长时间没有进展，已停止本轮。已收到的回复会保留，可以在本会话继续。');
        interrupt();
      }, idleMs);
    };
    input.signal.addEventListener('abort', interrupt, { once: true });
    const startupTimer = setTimeout(() => {
      failed(new Error('启动 Codex 会话超时。可以在本会话重试。'));
      child.kill();
    }, startupMs);
    try {
      await rpc('initialize', { clientInfo: { name: 'fignexus', title: 'FigNexus', version: '0.3.10' } });
      send({ method: 'initialized' });
      const account = Account.parse(await rpc('account/read', { refreshToken: false }));
      if (account.requiresOpenaiAuth && !account.account) throw Error('本机 Codex CLI 尚未登录。请在终端运行 codex login，再回到 Figma 重新发送。');
      const turnOptions = {
        cwd, approvalPolicy: 'never', sandbox: 'read-only',
        developerInstructions: [
          'You are the FigNexus design assistant. Use only the scoped FigNexus MCP tools to access Figma.',
          'Inspect the current selection for requests about selected layers. Make changes only when the user asks for changes.',
          'Use figma_update_node or figma_update_text for simple edits. Use figma_edit_nodes for batches, stroke edits, or clearing fills.',
          'For an explicit edit request, apply it through the FigNexus tools and check the returned result before claiming completion.',
          'If a FigNexus tool reports PLUGIN_PAUSED, explain that the canvas is temporarily asleep and ask the user to bring Figma into view before retrying.',
          'Use the session ID from figma_get_status. Follow the native tool safeguards and report the actual tool results.',
        ].join(' '),
      };
      let notice: string | undefined;
      const thread = Thread.parse(await (input.threadId
        ? rpc('thread/resume', { ...turnOptions, threadId: input.threadId, excludeTurns: true }).catch(error => {
            if (!(error instanceof CodexRpcError) || !error.activeWriter || input.signal.aborted) throw error;
            notice = '原 Codex 会话正在被占用，已从已有记录继续。';
            return rpc('thread/fork', { ...turnOptions, threadId: input.threadId, excludeTurns: true });
          })
        : rpc('thread/start', turnOptions)));
      threadId = thread.thread.id;
      await events.thread(threadId, notice);
      if (input.signal.aborted) return 'interrupted';
      const context = JSON.stringify({
        sessionId: input.target.sessionId, pageId: input.target.context.page.id,
        document: input.target.context.document.name, page: input.target.context.page.name,
      });
      const turn = Turn.parse(await rpc('turn/start', {
        threadId, input: [{ type: 'text', text: 'Current FigNexus canvas context: ' + context + '\n\n' + input.text }],
      }));
      turnId = turn.turn.id;
      clearTimeout(startupTimer);
      armIdleTimer();
      const result = await completed;
      if (input.signal.aborted) return 'interrupted';
      if (idleFailure) throw idleFailure;
      if (result.error) throw result.error;
      return result.status;
    } finally {
      input.signal.removeEventListener('abort', interrupt);
      clearTimeout(startupTimer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      lines.close();
      child.stdin.end();
      // EOF gives Codex time to flush its thread before a subsequent resume.
      const terminate = setTimeout(() => child.kill(), 2000);
      await closed;
      clearTimeout(terminate);
    }
  };
}
