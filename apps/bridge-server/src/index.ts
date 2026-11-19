import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './server';
import {AuditStore} from './audit';
import {QuickPairing} from './quick-pairing';
import {LocalPairPrompt} from './local-pair-prompt';
import {confirmWindows} from '../../pairing-helper/src/confirm';
import { CodexChats } from './codex-chat';
import { codexAppServer } from './codex-app-server';

const tokenFile = resolve(process.env.FIGMA_BRIDGE_TOKEN_FILE ?? '.bridge/token');
let token: string;
try { token = (await readFile(tokenFile, 'utf8')).trim(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  await mkdir(resolve(tokenFile, '..'), { recursive: true });
  token = randomBytes(32).toString('hex');
  await writeFile(tokenFile, token + '\n', { flag: 'wx', mode: 0o600 });
}
const audit=new AuditStore(resolve(process.env.FIGMA_BRIDGE_AUDIT_DIR??'.bridge/audit'));await audit.init();
const approvalFile=resolve(process.env.FIGMA_BRIDGE_PAIR_APPROVAL_FILE??resolve(tokenFile,'..','pair-approval'));
let approvalSecret:string;
try{approvalSecret=(await readFile(approvalFile,'utf8')).trim();}
catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  await mkdir(resolve(approvalFile,'..'),{recursive:true});approvalSecret=randomBytes(32).toString('hex');
  try{await writeFile(approvalFile,approvalSecret+'\n',{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;approvalSecret=(await readFile(approvalFile,'utf8')).trim();}
}
const pairing=new QuickPairing(token,approvalSecret);
const localPrompt=process.platform==='win32'?new LocalPairPrompt(pairing,approvalSecret,confirmWindows):undefined;
const dataDir = resolve(process.env.FIGMA_BRIDGE_DATA_DIR ?? resolve(tokenFile, '..'));
const mcpEntry = fileURLToPath(new URL('../../../packages/mcp-server/dist/index.js', import.meta.url));
const chat = new CodexChats(resolve(dataDir, 'chat'), codexAppServer(
  process.env.FIGMA_CODEX_COMMAND ?? 'codex', mcpEntry, resolve(dataDir, 'chat-workspace'),
));
const app = await createBridge(token, true,audit,{},pairing,localPrompt,chat);
await app.listen({ host: '127.0.0.1', port: 3055 });
console.error(`Pairing token file: ${tokenFile}. Read it locally and paste into the plugin; do not share it.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
