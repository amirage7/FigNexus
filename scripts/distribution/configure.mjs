import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {installConfig,uninstallConfig,planConfig} from './config.mjs';
const [mode,installDir,homeArg,dataArg]=process.argv.slice(2);
if(!['install','uninstall','preview'].includes(mode)||!installDir||!dataArg) throw new Error('Usage: configure.mjs install|uninstall|preview INSTALL_DIR CODEX_HOME DATA_DIR');
const codexHome=resolve(homeArg||process.env.CODEX_HOME||resolve(homedir(),'.codex'));
const receipt=resolve(codexHome,'.figma-ai-bridge-install.json');
let previous;try {previous=JSON.parse(await readFile(receipt,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const options={installDir:resolve(installDir),codexHome,dataDir:resolve(dataArg),previous};
if(previous && (previous.codexHome!==codexHome||previous.dataDir!==options.dataDir)) throw new Error('Receipt identity mismatch; inspect '+receipt);
if(mode==='preview') {
 let text='';try{text=await readFile(resolve(codexHome,'config.toml'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 planConfig(text,options);
 console.log(JSON.stringify({config:resolve(codexHome,'config.toml'),command:options.installDir+'/runtime/node.exe',args:[options.installDir+'/packages/mcp-server/dist/index.js'],dataDir:options.dataDir,startup_timeout_sec:90},null,2));
} else {
 const result=mode==='install'?await installConfig(options):await uninstallConfig(previous??options);
 if(mode==='install') {await mkdir(codexHome,{recursive:true});await writeFile(receipt,JSON.stringify({...options,previous:undefined},null,2));}
 console.log(JSON.stringify(result));
}
