import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';import {resolve} from 'node:path';
import {localManifest} from '../../../scripts/distribution/plugin-config.mjs';
export async function buildManifest(source,target){
 const manifest=localManifest(JSON.parse((await readFile(source,'utf8')).replace(/^\uFEFF/,'')));
 // Development import needs no ID. Only preserve one explicitly configured
 // by an existing user; publication packaging strips all local identities.
 await writeFile(target,JSON.stringify(manifest,null,2)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildManifest(new URL('../manifest.json',import.meta.url),new URL('../dist/manifest.json',import.meta.url));
