import {readFile,writeFile,rename,unlink,stat} from 'node:fs/promises';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';
export function localManifest(current,generated){
 if(!current||typeof current!=='object'||current.main!=='main.js'||current.ui!=='index.html')throw Error('Invalid installed plugin manifest');
 if(!generated||typeof generated.id!=='string'||!/^\d{1,64}$/.test(generated.id))throw Error('Select the manifest.json created by Figma with a numeric plugin ID');
 return {...current,id:generated.id};
}
async function bounded(path){if((await stat(path)).size>65536)throw Error('Manifest too large');const text=await readFile(path,'utf8');if(Buffer.byteLength(text)>65536)throw Error('Manifest too large');return text;}
export async function configureLocalPlugin(targetPath,generatedPath){
 const target=resolve(targetPath),source=resolve(generatedPath),original=await bounded(target),current=JSON.parse(original.replace(/^\uFEFF/,'')),next=localManifest(current,JSON.parse((await bounded(source)).replace(/^\uFEFF/,'')));
 if(next.id===current.id)return {changed:false,path:target};
 const backup=target+'.backup-'+Date.now()+'-'+randomUUID(),stage=target+'.stage-'+randomUUID();await writeFile(backup,original,{flag:'wx'});
 try{await writeFile(stage,JSON.stringify(next,null,2),{flag:'wx'});if(await bounded(target)!==original)throw Error('Plugin manifest changed during setup');await rename(stage,target);}finally{await unlink(stage).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 return {changed:true,path:target,backup};
}
