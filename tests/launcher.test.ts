import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { ensureBridge, probeBridge } from '../packages/mcp-server/src/launcher';
import { createServer, type Server } from 'node:http';
import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';

const dirs: string[] = [];
const servers: Server[] = [];
const token = 'a'.repeat(64);
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'figma-launcher-')); dirs.push(dataDir);
  return { FIGMA_BRIDGE_DATA_DIR: dataDir, FIGMA_BRIDGE_SERVER_ENTRY: join(dataDir, 'bridge.mjs') };
}
function child() { return Object.assign(new EventEmitter(), { unref: vi.fn() }); }
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })));
});
describe('local Bridge launcher', () => {
  it('creates token exclusively, starts hidden detached Bridge and redirects output', async () => {
    const env = await setup(); let healthy = false; const process = child();
    await writeFile(env.FIGMA_BRIDGE_SERVER_ENTRY, '');
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => { healthy = true; return process; });
    const result = await ensureBridge({ env, probe: async () => healthy ? 'healthy' : 'absent', spawn });
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(join(env.FIGMA_BRIDGE_DATA_DIR, 'token'), 'utf8')).trim()).toBe(result.token);
    expect(spawn).toHaveBeenCalledTimes(1);
    const options = spawn.mock.calls[0]?.[2];
    expect(options).toMatchObject({ detached: true, windowsHide: true, cwd: env.FIGMA_BRIDGE_DATA_DIR });
    expect(options?.env).toMatchObject({ FIGMA_BRIDGE_TOKEN_FILE: join(env.FIGMA_BRIDGE_DATA_DIR, 'token'), FIGMA_BRIDGE_AUDIT_DIR: join(env.FIGMA_BRIDGE_DATA_DIR, 'audit') });
    expect((options?.stdio as unknown[])[0]).toBe('ignore'); expect(typeof (options?.stdio as unknown[])[1]).toBe('number');
    expect(process.unref).toHaveBeenCalledOnce();
  });
  it('reuses an authenticated service and preserves its token', async () => {
    const env = await setup(); await writeFile(join(env.FIGMA_BRIDGE_DATA_DIR, 'token'), token);
    const spawn = vi.fn();
    expect((await ensureBridge({ env, probe: async () => 'healthy', spawn })).token).toBe(token);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects wrong token or stranger service without spawning', async () => {
    const env = await setup(); const spawn = vi.fn();
    await expect(ensureBridge({ env, probe: async () => 'occupied', spawn })).rejects.toThrow(/occupied|authentication/i);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('serializes simultaneous clients to exactly one start and one token', async () => {
    const env = await setup(); await writeFile(env.FIGMA_BRIDGE_SERVER_ENTRY, ''); let healthy = false;
    const spawn = vi.fn(() => { healthy = true; return child(); });
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureBridge({ env, probe: async () => healthy ? 'healthy' : 'absent', spawn, pollMs: 5 })));
    expect(new Set(results.map(r => r.token)).size).toBe(1); expect(spawn).toHaveBeenCalledOnce();
  });
  it('times out live or incomplete locks without removing them', async () => {
    const env = await setup(); const lock = join(env.FIGMA_BRIDGE_DATA_DIR, 'startup.lock'); await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, id: 'existing' }));
    await expect(ensureBridge({ env, probe: async () => 'absent', timeoutMs: 40, pollMs: 5 })).rejects.toThrow(/lock.*timed out/i);
    expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).id).toBe('existing');
  });
  it('recovers a validated dead owner and releases only its lock', async () => {
    const env = await setup(); await writeFile(env.FIGMA_BRIDGE_SERVER_ENTRY, '');
    const lock = join(env.FIGMA_BRIDGE_DATA_DIR, 'startup.lock'); await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, id: 'dead' }));
    let healthy = false;
    await ensureBridge({ env, probe: async () => healthy ? 'healthy' : 'absent', spawn: () => { healthy = true; return child(); }, pollMs: 5 });
    await expect(readFile(join(lock, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not remove an incomplete lock or an abandoned recovery guard', async () => {
    const env = await setup(); const lock = join(env.FIGMA_BRIDGE_DATA_DIR, 'startup.lock'); await mkdir(lock);
    await expect(ensureBridge({ env, probe: async () => 'absent', timeoutMs: 30, pollMs: 5 })).rejects.toThrow(/lock.*timed out/i);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, id: 'dead' }));
    await mkdir(join(env.FIGMA_BRIDGE_DATA_DIR, 'startup.recovery'));
    await expect(ensureBridge({ env, probe: async () => 'absent', timeoutMs: 30, pollMs: 5 })).rejects.toThrow(/lock.*timed out/i);
    expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).id).toBe('dead');
  });
  it('multiple clients safely recover one dead lock and spawn once', async () => {
    const env = await setup(); await writeFile(env.FIGMA_BRIDGE_SERVER_ENTRY, '');
    const lock = join(env.FIGMA_BRIDGE_DATA_DIR, 'startup.lock'); await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, id: 'dead' }));
    let healthy = false; const spawn = vi.fn(() => { healthy = true; return child(); });
    await Promise.all(Array.from({ length: 8 }, () => ensureBridge({ env, probe: async () => healthy ? 'healthy' : 'absent', spawn, pollMs: 5 })));
    expect(spawn).toHaveBeenCalledOnce();
  });
  it('reports spawn failure without revealing token', async () => {
    const env = await setup(); await writeFile(env.FIGMA_BRIDGE_SERVER_ENTRY, ''); await writeFile(join(env.FIGMA_BRIDGE_DATA_DIR, 'token'), token);
    await expect(ensureBridge({ env, probe: async () => 'absent', spawn: () => { throw new Error(token); } })).rejects.toThrow('Bridge process could not start');
  });
  it('bounds startup waiting and captures asynchronous child errors', async () => {
    const env = await setup(); await writeFile(env.FIGMA_BRIDGE_SERVER_ENTRY, '');
    await expect(ensureBridge({ env, probe: async () => 'absent', spawn: () => child(), timeoutMs: 40, pollMs: 5 })).rejects.toThrow(/startup timed out/i);
    await expect(ensureBridge({ env, probe: async () => 'absent', spawn: () => { const c = child(); setTimeout(() => c.emit('error', new Error(token)), 1); return c; }, timeoutMs: 100, pollMs: 5 })).rejects.toThrow('Bridge process could not start');
  });
  it('honors opt-out without creating files or probing', async () => {
    const env = await setup(); const file = join(env.FIGMA_BRIDGE_DATA_DIR, 'token'); await writeFile(file, token);
    const probe = vi.fn(); expect((await ensureBridge({ env: { ...env, FIGMA_BRIDGE_AUTOSTART: '0' }, probe })).token).toBe(token);
    expect(probe).not.toHaveBeenCalled();
  });
  it('derives the data directory from an explicit token file', async () => {
    const env = await setup(); const file = join(env.FIGMA_BRIDGE_DATA_DIR, 'explicit-token'); await writeFile(file, token);
    const result = await ensureBridge({ env: { FIGMA_BRIDGE_TOKEN_FILE: file }, probe: async () => 'healthy' });
    expect(result).toMatchObject({ tokenFile: file, dataDir: env.FIGMA_BRIDGE_DATA_DIR, token });
  });
  it('refuses remote URLs', async () => {
    await expect(ensureBridge({ env: { ...(await setup()), FIGMA_BRIDGE_URL: 'http://example.com:3055' } })).rejects.toThrow(/loopback/i);
  });
  it('probes real HTTP with exact Bearer token and distinguishes strangers and refusal', async () => {
    let modern = false;
    let healthPayload = { service: 'figma-ai-bridge', version: '0.3.2', protocolVersion: 1, capabilities: ['quick-pairing', 'timeout-barrier', 'native-visual', 'native-design', 'auto-pair-prompt', 'retained-preview','native-vectors'] };
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return; }
      if (req.url === '/v1/health') {
        if (!modern) { res.writeHead(404); res.end('{}'); return; }
        res.end(JSON.stringify(healthPayload)); return;
      }
      res.end(JSON.stringify({ version: 1, online: false, sessions: [], permissions: [] }));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
    expect(await probeBridge(url, token, 1000)).toBe('occupied');
    modern = true;
    expect(await probeBridge(url, token, 1000)).toBe('healthy');
    const compatible = healthPayload;
    for (const change of [{ version:'0.3.0' },{capabilities:['quick-pairing','timeout-barrier','native-visual','native-design']},{ version: '0.2.0', capabilities: ['quick-pairing', 'timeout-barrier'] }, { version: '0.2.9' }, { version: '0.3.0-beta' }, { service: 'other-service' }, { protocolVersion: 2 }, { capabilities: ['quick-pairing', 'timeout-barrier', 'native-design'] }, { capabilities: ['quick-pairing', 'timeout-barrier', 'native-visual'] }]) {
      healthPayload = { ...compatible, ...change };
      expect(await probeBridge(url, token, 1000)).toBe('occupied');
    }
    healthPayload = { ...compatible, version: '0.3.2' };
    expect(await probeBridge(url, token, 1000)).toBe('healthy');
    expect(await probeBridge(url, 'b'.repeat(64), 1000)).toBe('occupied');
    await new Promise<void>(resolve => server.close(() => resolve())); servers.pop();
    expect(await probeBridge(url, token, 1000)).toBe('absent');
  });
  it('five independent MCP processes share one real detached service', async () => {
    const env = await setup(); const dir = env.FIGMA_BRIDGE_DATA_DIR;
    const reserve = createServer();
    await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(done => reserve.close(() => done()));
    const require = createRequire(resolve('packages/mcp-server/package.json'));
    const build = require('esbuild').build as (options: unknown) => Promise<unknown>;
    await build({ entryPoints: [resolve('packages/mcp-server/src/launcher.ts')], outfile: join(dir, 'launcher.mjs'), bundle: true, platform: 'node', format: 'esm' });
    await writeFile(env.FIGMA_BRIDGE_SERVER_ENTRY, `
      import { createServer } from 'node:http';
      import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const dir=process.env.FIGMA_BRIDGE_DATA_DIR;
      const token=readFileSync(process.env.FIGMA_BRIDGE_TOKEN_FILE,'utf8').trim();
      appendFileSync(join(dir,'starts.log'),'started\\n');
      writeFileSync(join(dir,'fixture.pid'),String(process.pid));
      createServer((req,res)=>{
        if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return;}
        res.setHeader('Content-Type','application/json');
        if(req.url==='/v1/health'){res.end(JSON.stringify({service:'figma-ai-bridge',version:'0.3.2',protocolVersion:1,capabilities:['quick-pairing','timeout-barrier','native-visual','native-design','auto-pair-prompt','retained-preview','native-vectors']}));return;}
        res.end(JSON.stringify({version:1,online:false,sessions:[],permissions:[]}));
      }).listen(Number(process.env.FIXTURE_PORT),'127.0.0.1');
    `);
    const runner = join(dir, 'runner.mjs');
    await writeFile(runner, `
      import {ensureBridge,probeBridge} from './launcher.mjs';
      await ensureBridge({probe:(_url,token,ms)=>probeBridge('http://127.0.0.1:'+process.env.FIXTURE_PORT,token,ms)});
    `);
    try {
      await Promise.all(Array.from({ length: 5 }, () => new Promise<void>((done, reject) => {
        const child = spawnProcess(process.execPath, [runner], { windowsHide: true, env: { ...process.env, ...env, FIXTURE_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error(`Fixture client exited ${code}: ${stderr}`)));
      })));
      expect((await readFile(join(dir, 'starts.log'), 'utf8')).trim().split('\n')).toHaveLength(1);
      const sharedToken = (await readFile(join(dir, 'token'), 'utf8')).trim();
      expect(await probeBridge(`http://127.0.0.1:${port}`, sharedToken, 1000)).toBe('healthy');
    } finally {
      // Only the PID written by this isolated fixture is eligible for cleanup.
      const pid = Number(await readFile(join(dir, 'fixture.pid'), 'utf8').catch(() => '0'));
      if (pid > 0) { try { process.kill(pid); } catch {} }
    }
  }, 20000);
});
