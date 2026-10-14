import {expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import * as config from '../scripts/distribution/plugin-config.mjs';
const direct={name:'FigNexus',api:'1.0.0',main:'main.js',ui:'index.html',networkAccess:{allowedDomains:['none']}};
async function fixture(){const root=await mkdtemp(resolve('.bridge','direct setup '));const install=resolve(root,'release'),data=resolve(root,'data');await mkdir(resolve(install,'plugin'),{recursive:true});await writeFile(resolve(install,'plugin/manifest.json'),JSON.stringify(direct));return {root,install,data,target:resolve(install,'plugin/manifest.json')};}
it('accepts a manifest without ID and preserves an explicitly existing real ID',()=>{
 expect(config.localManifest(direct)).toEqual(direct);
 expect(config.localManifest({...direct,id:'123456789'})).toEqual({...direct,id:'123456789'});
 expect(()=>config.localManifest({...direct,id:'fabricated-name'})).toThrow();
});
it('default setup is read-only and needs no generated manifest or backup',async()=>{
 const f=await fixture();const before=await readFile(f.target,'utf8');
 expect(await config.configureLocalPlugin(f.target)).toMatchObject({changed:false,path:f.target});
 expect(await readFile(f.target,'utf8')).toBe(before);expect(await readdir(resolve(f.install,'plugin'))).toEqual(['manifest.json']);
});
it('fresh installs do not generate any ID or require a Figma template',async()=>{
 const f=await fixture();const r=await (config as any).prepareInstalledPlugin(f.install,f.data);
 expect(r).toMatchObject({mode:'direct-import',path:f.target});expect(JSON.parse(await readFile(f.target,'utf8'))).toEqual(direct);
});
it('migrates a previous managed plugin ID then reuses it on the next upgrade',async()=>{
 const f=await fixture();const previous=resolve(f.root,'previous');await mkdir(resolve(previous,'plugin'),{recursive:true});await writeFile(resolve(previous,'plugin/manifest.json'),JSON.stringify({...direct,id:'123456789'}));
 expect(await (config as any).prepareInstalledPlugin(f.install,f.data,previous)).toMatchObject({mode:'reuse-id'});
 expect(JSON.parse(await readFile(f.target,'utf8')).id).toBe('123456789');
 const next=resolve(f.root,'next');await mkdir(resolve(next,'plugin'),{recursive:true});await writeFile(resolve(next,'plugin/manifest.json'),JSON.stringify(direct));
 expect(await (config as any).prepareInstalledPlugin(next,f.data)).toMatchObject({mode:'reuse-id'});expect(JSON.parse(await readFile(resolve(next,'plugin/manifest.json'),'utf8')).id).toBe('123456789');
});
it('retains current ID and refuses conflicting or corrupt saved identity without changing files',async()=>{
 const f=await fixture();await mkdir(f.data);await writeFile(f.target,JSON.stringify({...direct,id:'111'}));await writeFile(resolve(f.data,'plugin-id.json'),JSON.stringify({version:1,id:'222'}));
 const before=await readFile(f.target,'utf8');await expect((config as any).prepareInstalledPlugin(f.install,f.data)).rejects.toThrow(/conflict/i);expect(await readFile(f.target,'utf8')).toBe(before);
 await writeFile(resolve(f.data,'plugin-id.json'),'{broken');await expect((config as any).prepareInstalledPlugin(f.install,f.data)).rejects.toThrow();expect(await readFile(f.target,'utf8')).toBe(before);
});
it('first-use script has only direct import instructions; explicit legacy reuse remains optional',async()=>{
 const script=await readFile('scripts/distribution/setup-plugin.ps1','utf8');expect(script).not.toContain('New plugin');expect(script).not.toContain('OpenFileDialog');expect(script).toContain('Import plugin from manifest');expect(script).toContain('GeneratedManifest');
});
