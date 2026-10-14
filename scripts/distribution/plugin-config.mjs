import {readFile,writeFile,rename,unlink,stat,mkdir,link} from 'node:fs/promises';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';
function validId(id){return typeof id==='string'&&/^\d{1,64}$/.test(id);}
export function localManifest(current,generated){
 if(!current||typeof current!=='object'||current.main!=='main.js'||current.ui!=='index.html')throw Error('Invalid installed plugin manifest');
 if(generated===undefined){if(current.id!==undefined&&!validId(current.id))throw Error('Invalid existing Figma plugin ID');return {...current};}
 if(!generated||!validId(generated.id))throw Error('Select an existing Figma manifest with a numeric plugin ID');
 return {...current,id:generated.id};
}
async function bounded(path){if((await stat(path)).size>65536)throw Error('Manifest too large');const text=await readFile(path,'utf8');if(Buffer.byteLength(text)>65536)throw Error('Manifest too large');return text;}
export async function configureLocalPlugin(targetPath,generatedPath){
 const target=resolve(targetPath),original=await bounded(target),current=JSON.parse(original.replace(/^\uFEFF/,'')),next=localManifest(current,generatedPath?JSON.parse((await bounded(resolve(generatedPath))).replace(/^\uFEFF/,'')):undefined);
 if(next.id===current.id)return {changed:false,path:target};
 const backup=target+'.backup-'+Date.now()+'-'+randomUUID(),stage=target+'.stage-'+randomUUID();await writeFile(backup,original,{flag:'wx'});
 try{await writeFile(stage,JSON.stringify(next,null,2),{flag:'wx'});if(await bounded(target)!==original)throw Error('Plugin manifest changed during setup');await rename(stage,target);}finally{await unlink(stage).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 return {changed:true,path:target,backup};
}
async function optionalJson(path){try{return JSON.parse((await bounded(path)).replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
export async function inspectPluginIdentity(target,dataDir,previousInstallDir,generatedPath){
 target=resolve(target);const original=await bounded(target),current=localManifest(JSON.parse(original.replace(/^\uFEFF/,'')));
 const savedPath=resolve(dataDir,'plugin-id.json'),saved=await optionalJson(savedPath);
 if(saved!==undefined&&(saved.version!==1||!validId(saved.id)))throw Error('Invalid saved Figma plugin identity; original files retained');
 const previous=previousInstallDir&&resolve(previousInstallDir,'plugin/manifest.json')!==target?await optionalJson(resolve(previousInstallDir,'plugin/manifest.json')):undefined;
 if(previous?.id!==undefined&&!validId(previous.id))throw Error('Invalid previous Figma plugin ID');
 const generated=generatedPath?JSON.parse((await bounded(resolve(generatedPath))).replace(/^\uFEFF/,'')):undefined;
 if(generatedPath&&!validId(generated?.id))throw Error('Select an existing Figma manifest with a numeric plugin ID');
 const ids=[current.id,saved?.id,previous?.id,generated?.id].filter(id=>id!==undefined);
 if(new Set(ids).size>1)throw Error('Figma plugin ID conflict; original files retained');
 return {id:ids[0],current,original,savedPath,saved,path:target,mode:ids.length?'reuse-id':'direct-import'};
}
export async function prepareInstalledPlugin(installDir,dataDir,previousInstallDir,generatedPath){
 const plan=await inspectPluginIdentity(resolve(installDir,'plugin/manifest.json'),dataDir,previousInstallDir,generatedPath);
 const {id,current,original,savedPath,saved,path:target}=plan;
 if(id===undefined)return {mode:'direct-import',path:target,changed:false};
 // Persist only IDs already present in a local manifest or installer data;
 // this function never creates a Figma ID.
 await mkdir(dataDir,{recursive:true});
 if(!saved){
  const temporary=savedPath+'.stage-'+randomUUID();
  try{
   await writeFile(temporary,JSON.stringify({version:1,id}),{flag:'wx'});
   // Publish a complete file without replacing an identity from another installer.
   try{await link(temporary,savedPath);}catch(e){if(e.code!=='EEXIST')throw e;const concurrent=await optionalJson(savedPath);if(concurrent?.version!==1||concurrent.id!==id)throw Error('Concurrent Figma plugin ID conflict');}
  }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 if(await bounded(target)!==original)throw Error('Plugin manifest changed during setup; original retained');
 const result=current.id===id?{changed:false,path:target}:await configureLocalPlugin(target,savedPath);
 return {...result,mode:'reuse-id'};
}
