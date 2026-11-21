import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';import {resolve} from 'node:path';
import {localManifest} from '../../../scripts/distribution/plugin-config.mjs';
export async function buildManifest(source,target){
 const manifest=localManifest(JSON.parse((await readFile(source,'utf8')).replace(/^\uFEFF/,'')));
 // Preserve the configured identity so the plugin can use Figma client storage.
 await writeFile(target,JSON.stringify(manifest,null,2)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildManifest(new URL('../manifest.json',import.meta.url),new URL('../dist/manifest.json',import.meta.url));
