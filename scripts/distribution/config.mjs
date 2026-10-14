import TOML from './vendor/toml/toml.js';
import {readFile,writeFile,mkdir,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const name='figma-ai-bridge';
const begin='# BEGIN Figma AI Bridge managed entry v1';
const end='# END Figma AI Bridge managed entry v1';
const portable=p=>resolve(p).replaceAll('\\','/');
export function managedEntry({installDir,dataDir}) {
 const root=portable(installDir),data=portable(dataDir);
 return {command:root+'/runtime/node.exe',args:[root+'/packages/mcp-server/dist/index.js'],cwd:data,startup_timeout_sec:90,env:{FIGMA_BRIDGE_DATA_DIR:data,FIGMA_BRIDGE_TOKEN_FILE:data+'/token',FIGMA_BRIDGE_AUDIT_DIR:data+'/audit'}};
}
function block(options,newline='\n') {
 const entry=managedEntry(options);
 return begin+newline+TOML.stringify({mcp_servers:{[name]:entry}}).replaceAll('\n',newline)+end+newline;
}
export function planConfig(original,options,remove=false) {
 const config=TOML.parse(original.replace(/^\uFEFF/,''));
 const existing=config.mcp_servers?.[name];
 if(existing && !isDeepStrictEqual(existing,managedEntry(options))) {
  if(!remove && options.previous && isDeepStrictEqual(existing,managedEntry(options.previous))) return planConfig(planConfig(original,options.previous,true),{...options,previous:undefined});
  throw new Error((remove?'Installation identity mismatch':'Codex MCP conflict')+': '+JSON.stringify(existing,null,2));
 }
 if(remove) {
  if(!existing) return original;
  const own=block(options,original.includes('\r\n')?'\r\n':'\n');
  const offset=original.indexOf(own);
  if(offset<0 || original.indexOf(own,offset+1)>=0) throw new Error('Installation identity mismatch: managed entry changed; preserve config and inspect manually');
  // The extra leading newline belongs to this installation, never to user settings.
  const cut=offset>0 && original[offset-1]==='\n' ? offset-(original[offset-2]==='\r'?2:1) : offset;
  const result=original.slice(0,cut)+original.slice(offset+own.length);
  TOML.parse(result.replace(/^\uFEFF/,''));
  return result;
 }
 if(existing) return original;
 const nl=original.includes('\r\n')?'\r\n':'\n';
 const result=original+(original?nl:'')+block(options,nl);
 const parsed=TOML.parse(result.replace(/^\uFEFF/,''));
 if(!isDeepStrictEqual(parsed.mcp_servers[name],managedEntry(options))) throw new Error('Generated entry validation failed');
 return result;
}
async function update(options,remove) {
 const home=resolve(options.codexHome),path=resolve(home,'config.toml');
 await mkdir(home,{recursive:true});
 const lock=path+'.figma-ai-bridge.lock';
 await writeFile(lock,String(process.pid),{flag:'wx'}).catch(()=>{throw new Error('Another configuration update is active; inspect '+lock);});
 try {
  let original='';
  try { original=await readFile(path,'utf8'); } catch(e) { if(e.code!=='ENOENT') throw e; }
  const next=planConfig(original,options,remove);
  if(next===original) return {changed:false};
  const backup=path+'.figma-ai-bridge-backup-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID();
  await writeFile(backup,original,{flag:'wx'});
  // Do not replace edits made by a running Codex or editor since the initial read.
  let current='';try {current=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(current!==original) throw new Error('Codex config changed while preparing update; retry');
  const temporary=path+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,next,{flag:'wx'});
  await rename(temporary,path);
  return {changed:true,backup};
 } finally { await unlink(lock); }
}
export const installConfig=options=>update(options,false);
export const uninstallConfig=options=>update(options,true);
