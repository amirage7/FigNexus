import { randomBytes, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { access, mkdir, open, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Status } from '@bridge/protocol';

type Health = 'healthy' | 'absent' | 'occupied';
type Child = { on(event: string, listener: (...args: any[]) => void): unknown; unref(): void };
export interface LauncherOptions {
  env?: NodeJS.ProcessEnv;
  probe?: (url: string, token: string, timeoutMs: number) => Promise<Health>;
  spawn?: (command: string, args: string[], options: SpawnOptions) => Child;
  timeoutMs?: number;
  pollMs?: number;
}

/** Only an actual connection refusal means a free port. Timeouts and malformed replies fail closed. */
export async function probeBridge(url: string, token: string, timeoutMs: number): Promise<Health> {
  let statusAccepted = false;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const get = async (path: string): Promise<unknown> => {
      const response = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}`, Connection: 'close' }, signal, redirect: 'error' });
      if (!response.ok || !response.body) { await response.body?.cancel(); return undefined; }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length;
          if (bytes > 65536) { await reader.cancel(); return undefined; }
          chunks.push(next.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { reader.releaseLock(); }
    };
    if (!Status.safeParse(await get('/v1/status')).success) return 'occupied';
    statusAccepted = true;
    const health = await get('/v1/health') as { service?: unknown; version?: unknown; protocolVersion?: unknown; capabilities?: unknown } | undefined;
    const version = typeof health?.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(health.version) ? health.version.split('.').map(Number) : [];
    const compatible = version.length === 3 && version.every(Number.isSafeInteger) && (version[0] > 0 || version[1] > 3 || (version[1] === 3 && version[2] >= 2));
    const capabilities = health?.capabilities;
    return health?.service === 'figma-ai-bridge' && compatible && health.protocolVersion === 1 && Array.isArray(capabilities) && ['quick-pairing', 'timeout-barrier', 'native-visual', 'native-design', 'auto-pair-prompt', 'retained-preview','native-vectors'].every(capability => capabilities.includes(capability)) ? 'healthy' : 'occupied';
  } catch (error) {
    if (statusAccepted) return 'occupied';
    const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
    return cause?.code === 'ECONNREFUSED' || (cause?.errors?.length && cause.errors.every(e => e.code === 'ECONNREFUSED')) ? 'absent' : 'occupied';
  }
}

function validateToken(token: string) {
  if (token.length < 32 || token.length > 256 || /[\r\n\s]/.test(token)) throw new Error('Invalid pairing token file');
  return token;
}
type Owner = { pid: number; id: string };
async function ownerAt(lock: string): Promise<Owner | undefined> {
  try {
      const value = JSON.parse(await readFile(resolve(lock, 'owner.json'), 'utf8'));
    if (Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.id === 'string' && value.id.length > 0) return value;
  } catch { /* An incomplete/unknown lock is never removed. */ }
}
function dead(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
async function release(lock: string, owner: Owner) {
  const current = await ownerAt(lock);
  if (current?.id !== owner.id || current.pid !== owner.pid) return;
  try { await unlink(resolve(lock, 'owner.json')); await rmdir(lock); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
async function recoverDeadOwner(lock: string, prior: Owner) {
  // Serialize reclamation so two stale readers cannot remove a replacement lock.
  // An abandoned recovery guard is left for local inspection and bounded timeout.
  const guard = resolve(dirname(lock), 'startup.recovery');
  try { await mkdir(guard); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try {
    const current = await ownerAt(lock);
    if (current?.id === prior.id && current.pid === prior.pid && dead(current.pid)) await release(lock, current);
  } finally { await rmdir(guard); }
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function ensureBridge(options: LauncherOptions = {}): Promise<{ token: string; tokenFile: string; dataDir: string }> {
  const env = options.env ?? process.env;
  const tokenFile = resolve(env.FIGMA_BRIDGE_TOKEN_FILE ?? (env.FIGMA_BRIDGE_DATA_DIR ? resolve(env.FIGMA_BRIDGE_DATA_DIR, 'token') : '.bridge/token'));
  const dataDir = resolve(env.FIGMA_BRIDGE_DATA_DIR ?? dirname(tokenFile));
  const result = (token: string) => ({ token: validateToken(token), tokenFile, dataDir });
  if (env.FIGMA_BRIDGE_AUTOSTART === '0') return result((await readFile(tokenFile, 'utf8')).trim());
  const url = new URL(env.FIGMA_BRIDGE_URL ?? 'http://127.0.0.1:3055');
  if (url.origin !== 'http://127.0.0.1:3055' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Only loopback Bridge on port 3055 is supported');
  const entry = resolve(env.FIGMA_BRIDGE_SERVER_ENTRY ?? fileURLToPath(new URL('../../../apps/bridge-server/dist/index.js', import.meta.url)));
  const timeoutMs = options.timeoutMs ?? 10000; const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs; const probe = options.probe ?? probeBridge;
  await mkdir(dataDir, { recursive: true }); await mkdir(dirname(tokenFile), { recursive: true });
  let token: string;
  try { token = (await readFile(tokenFile, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Pairing token file could not be read');
    try { await writeFile(tokenFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Pairing token file could not be created'); }
    // A competing exclusive writer may still be completing its first write.
    do { token = (await readFile(tokenFile, 'utf8')).trim(); if (token) break; await delay(pollMs); } while (Date.now() < deadline);
  }
  while (!token && Date.now() < deadline) { await delay(pollMs); token = (await readFile(tokenFile, 'utf8')).trim(); }
  validateToken(token);
  const health = () => probe(url.origin, token, Math.max(1, Math.min(750, deadline - Date.now())));
  const assertFree = (state: Health) => { if (state === 'occupied') throw new Error('Bridge port is occupied, authentication failed, or the running Bridge is incompatible. Stop the old service manually and restart the installed Bridge; check the local token file if authentication failed.'); };
  let state = await health(); if (state === 'healthy') return result(token); assertFree(state);
  const lock = resolve(dataDir, 'startup.lock'); const owner: Owner = { pid: process.pid, id: randomUUID() };
  while (true) {
    try {
      await mkdir(lock);
      try { await writeFile(resolve(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
      catch { await rmdir(lock).catch(() => undefined); throw new Error('Bridge startup lock could not be initialized'); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      state = await health(); if (state === 'healthy') return result(token); assertFree(state);
      const prior = await ownerAt(lock); if (prior && dead(prior.pid)) await recoverDeadOwner(lock, prior);
      if (Date.now() >= deadline) throw new Error('Bridge startup lock timed out; inspect the local data directory');
      await delay(pollMs);
    }
  }
  try {
    state = await health(); if (state === 'healthy') return result(token); assertFree(state);
    try { await access(entry); } catch { throw new Error('Bridge server entry is missing; reinstall the local Bridge package'); }
    const logs = await open(resolve(dataDir, 'bridge.log'), 'a', 0o600);
    let failed = false; let exited = false; let child: Child;
    try {
      child = (options.spawn ?? nodeSpawn)(process.execPath, [entry], {
        cwd: dataDir, detached: true, windowsHide: true, stdio: ['ignore', logs.fd, logs.fd],
        env: { ...process.env, ...env, FIGMA_BRIDGE_TOKEN_FILE: tokenFile, FIGMA_BRIDGE_DATA_DIR: dataDir, FIGMA_BRIDGE_AUDIT_DIR: resolve(env.FIGMA_BRIDGE_AUDIT_DIR ?? resolve(dataDir, 'audit')) },
      });
      child.on('error', () => { failed = true; }); child.on('exit', () => { exited = true; });
    } catch { throw new Error('Bridge process could not start; inspect the local bridge.log'); }
    finally { await logs.close(); }
    try { while (Date.now() < deadline) {
      if (failed) throw new Error('Bridge process could not start; inspect the local bridge.log');
      state = await health(); if (state === 'healthy') return result(token);
      assertFree(state);
      if (exited) throw new Error('Bridge process exited before becoming ready; inspect the local bridge.log');
      await delay(pollMs);
    }
    throw new Error('Bridge startup timed out; inspect the local bridge.log');
    } finally { child.unref(); }
  } finally { await release(lock, owner); }
}
