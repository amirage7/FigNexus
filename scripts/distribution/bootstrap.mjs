import {readFile,stat,access} from 'node:fs/promises';import {resolve,sep} from 'node:path';import {fileURLToPath} from 'node:url';
import {planConfig} from './config.mjs';
async function json(path){if((await stat(path)).size>65536)throw Error('Startup metadata too large');return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}
function version(value){if(typeof value!=='string'||!/^\d+\.\d+\.\d+$/.test(value))throw Error('Invalid release version');return value.split('.').map(Number);}
function newer(a,b){const x=version(a),y=version(b);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;}
export async function planStartup(packageRoot,codexHome,dataRoot){
 packageRoot=resolve(packageRoot);codexHome=resolve(codexHome);dataRoot=resolve(dataRoot);
 const source=await json(resolve(packageRoot,'distribution.json'));version(source.version);
 if(typeof source.bundleId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(source.bundleId))throw Error('Invalid release identity');
 const installDir=resolve(dataRoot,'releases',source.bundleId),dataDir=resolve(dataRoot,'data');
 let previous;try{previous=await json(resolve(codexHome,'.figma-ai-bridge-install.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(previous&&(previous.codexHome!==codexHome||previous.dataDir!==dataDir||typeof previous.installDir!=='string'))throw Error('Installation receipt identity mismatch');
 let original='';try{original=await readFile(resolve(codexHome,'config.toml'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 const options={installDir,codexHome,dataDir,previous};
 // Validate ownership even when startup will only read an installed version.
 planConfig(original,options);
 if(previous&&planConfig(original,previous)===original){
  const root=resolve(previous.installDir),prefix=resolve(dataRoot,'releases')+sep;
  if(!root.toLowerCase().startsWith(prefix.toLowerCase()))throw Error('Installed release outside managed directory');
  const installed=await json(resolve(root,'distribution.json'));
  if(installed.bundleId===source.bundleId||newer(installed.version,source.version)){
   for(const file of ['runtime/node.exe','packages/mcp-server/dist/index.js','plugin/manifest.json'])await access(resolve(root,file));
   return {needsInstall:false,installDir:root,codexHome,dataRoot};
  }
 }
 return {needsInstall:true,installDir,codexHome,dataRoot};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [root,home,data]=process.argv.slice(2);if(!root||!home||!data)throw Error('Specify package, Codex and data directories');
 console.log(JSON.stringify(await planStartup(root,home,data)));
}
