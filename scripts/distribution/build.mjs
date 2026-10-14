import {readFile,writeFile,mkdir,cp,readdir,realpath,access} from 'node:fs/promises';
import {resolve,dirname,join,relative} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

async function metadata(path) {return JSON.parse(await readFile(join(path,'package.json'),'utf8'));}
async function locate(name,from) {
 // Follow Node's lookup directories, including pnpm's per-package node_modules.
 const require=createRequire(join(from,'package.json'));
 for(const base of require.resolve.paths(name+'/package.json')??[]) {
  const candidate=join(base,name);
  try {const actual=await realpath(candidate);if((await metadata(actual)).name===name)return actual;}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}
 }
 throw new Error('Missing production dependency '+name+' from '+from);
}
async function productionClosure(roots) {
 const packages=new Map();
 async function visit(name,from,optional=false) {
  let path;try{path=await locate(name,from);}catch(e){if(optional)return;throw e;}
  const info=await metadata(path);
  const id=info.name+'@'+info.version;
  if(packages.has(id))return id;
  const edges=new Map();packages.set(id,{path,info,edges});
  for(const dependency of Object.keys(info.dependencies??{}))edges.set(dependency,await visit(dependency,path));
  for(const dependency of Object.keys(info.optionalDependencies??{})){const target=await visit(dependency,path,true);if(target)edges.set(dependency,target);}
  for(const dependency of Object.keys(info.peerDependencies??{})){const target=await visit(dependency,path,info.peerDependenciesMeta?.[dependency]?.optional===true);if(target)edges.set(dependency,target);}
  return id;
 }
 for(const root of roots) {const info=await metadata(root);for(const name of Object.keys(info.dependencies??{}))if(!name.startsWith('@bridge/'))await visit(name,root);}
 return packages;
}
export async function stageDistribution({root,output,nodePath,nodeLicense,installerSource=join(root,'scripts/distribution')}) {
 root=resolve(root);output=resolve(output);
 try{await access(output);throw new Error('Output already exists; choose a fresh directory: '+output);}catch(e){if(e.code!=='ENOENT')throw e;}
 const roots=[root];
 for(const p of ['apps/bridge-server','packages/mcp-server','apps/pairing-helper']) {try{await access(join(root,p,'package.json'));roots.push(join(root,p));}catch(e){if(e.code!=='ENOENT')throw e;}}
 const closure=await productionClosure(roots);
 const runtimeLicense=await readFile(nodeLicense,'utf8');if(!runtimeLicense.trim())throw new Error('Node license is required');
 const builds=['apps/bridge-server/dist','packages/mcp-server/dist','apps/pairing-helper/dist'];
 for(const p of builds) await access(join(root,p,'index.js'));
 await mkdir(output,{recursive:true});
 for(const p of builds) await cp(join(root,p),join(output,p),{recursive:true});
 await mkdir(join(output,'plugin'));
 for(const file of ['main.js','index.html','manifest.json'])await cp(join(root,'apps/figma-plugin/dist',file),join(output,'plugin',file));
 const manifest=JSON.parse(await readFile(join(output,'plugin/manifest.json'),'utf8'));
 delete manifest.id;
 manifest.name='FigNexus';
 await writeFile(join(output,'plugin/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const candidate={...manifest,name:'FigNexus (Production Candidate)',networkAccess:{allowedDomains:['http://localhost:3055','ws://localhost:3055'],reasoning:'Connect only to the local FigNexus on this computer for user-approved automation.'}};
 await writeFile(join(output,'plugin/manifest.production-candidate.json'),JSON.stringify(candidate,null,2));
 await cp(installerSource,join(output,'scripts/distribution'),{recursive:true,filter:source=>!['build.mjs','node-LICENSE.txt'].includes(source.split(/[\\/]/).at(-1))});
 for(const name of ['install.ps1','install.cmd','uninstall.ps1','uninstall.cmd','connect.ps1','连接 Figma.cmd','start.ps1','setup-plugin.ps1','开始使用.cmd'])await cp(join(installerSource,name),join(output,name));
 await cp(resolve(installerSource,'../../docs/windows-install.md'),join(output,'Windows安装说明.md'));
 await cp(resolve(installerSource,'../../docs/images'),join(output,'images'),{recursive:true});
 await cp(resolve(installerSource,'../../docs/clients'),join(output,'clients'),{recursive:true});
 await mkdir(join(output,'runtime'));
 await cp(nodePath,join(output,'runtime/node.exe'));
 await writeFile(join(output,'runtime/LICENSE.txt'),runtimeLicense);
 await mkdir(join(output,'node_modules'));
 const defaults=new Map();for(const [id,{info}] of closure)if(!defaults.has(info.name))defaults.set(info.name,id);
 async function emit(id,destination,available) {
  const {path,edges}=closure.get(id);
  await cp(path,destination,{recursive:true,dereference:true,filter:source=>source===path||!relative(path,source).split(/[\\/]/).includes('node_modules')});
  const local=new Map(available);
  for(const [name,target] of edges)if(local.get(name)!==target)local.set(name,target);
  for(const [name,target] of edges)if(available.get(name)!==target)await emit(target,join(destination,'node_modules',name),local);
 }
 for(const [name,id] of defaults)await emit(id,join(output,'node_modules',name),defaults);
 const version=(await metadata(root)).version;
 await writeFile(join(output,'package.json'),JSON.stringify({name:'figma-ai-bridge-portable',version,type:'module',private:true},null,2));
 const hashes={};
 async function walk(path) {for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isSymbolicLink())throw new Error('Unexpected symlink '+p);if(entry.isDirectory())await walk(p);else hashes[relative(output,p).replaceAll('\\','/')]=createHash('sha256').update(await readFile(p)).digest('hex');}}
 await walk(output);
 const bundleId=version+'-'+createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0,12);
 await writeFile(join(output,'distribution.json'),JSON.stringify({version,bundleId,platform:'win32',architecture:process.arch,productionPackages:[...closure.values()].map(({info})=>({name:info.name,version:info.version})),sha256:hashes},null,2));
 return {output,bundleId,packages:closure.size};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 if(process.platform!=='win32')throw new Error('Build Windows release on Windows with a Windows Node runtime');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const output=resolve(process.argv[2]??join(root,'.bridge','windows-release-'+Date.now()));
 const nodePath=resolve(process.env.FIGMA_DISTRIBUTION_NODE??process.execPath);
 const runtime=JSON.parse(execFileSync(nodePath,['-p','JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})'],{encoding:'utf8'}));
 const [major,minor]=runtime.version.slice(1).split('.').map(Number);
 if(runtime.platform!=='win32'||major<22||(major===22&&minor<16))throw new Error('A Windows Node runtime >=22.16 is required');
 if(runtime.version!=='v22.16.0'&&!process.env.FIGMA_DISTRIBUTION_NODE_LICENSE)throw new Error('Specify FIGMA_DISTRIBUTION_NODE_LICENSE for runtime '+runtime.version);
 const nodeLicense=resolve(process.env.FIGMA_DISTRIBUTION_NODE_LICENSE??join(root,'scripts/distribution/vendor/node-LICENSE.txt'));
 const result=await stageDistribution({root,output,nodePath,nodeLicense});
 const zip=output+'.zip';
 // Environment arguments prevent PowerShell quoting or metacharacter interpretation in paths.
 execFileSync('powershell.exe',['-NoProfile','-Command','Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:FIGMA_ZIP_SOURCE -Force).FullName -DestinationPath $env:FIGMA_ZIP_DEST -CompressionLevel Optimal'],{env:{...process.env,FIGMA_ZIP_SOURCE:output,FIGMA_ZIP_DEST:zip},stdio:'inherit'});
 console.log(JSON.stringify({...result,zip},null,2));
}
