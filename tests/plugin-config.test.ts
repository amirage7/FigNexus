import {expect,it} from 'vitest';import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';import {resolve} from 'node:path';
import {configureLocalPlugin,localManifest} from '../scripts/distribution/plugin-config.mjs';
it('uses a Figma generated numeric ID without changing bundle entry points or network permissions',()=>{
 const current={id:'111',main:'main.js',ui:'index.html',networkAccess:{allowedDomains:['none'],devAllowedDomains:['http://localhost:3055','ws://localhost:3055']}};expect(localManifest(current,{id:'1234567890123456789',main:'other.js'})).toEqual({...current,id:'1234567890123456789'});expect(current.id).toBe('111');expect(()=>localManifest(current,{id:'../bad'})).toThrow('Figma');
});
it('updates installed manifest atomically with a backup and makes the same setup idempotent',async()=>{
 const root=await mkdtemp(resolve('.bridge','plugin setup ')),folder=resolve(root,'plugin');await mkdir(folder);const target=resolve(folder,'manifest.json'),source=resolve(root,'generated.json');const original=JSON.stringify({id:'111',main:'main.js',ui:'index.html'});await writeFile(target,original);await writeFile(source,JSON.stringify({id:'222'}));const result=await configureLocalPlugin(target,source);expect(await readFile(result.backup!,'utf8')).toBe(original);expect(JSON.parse(await readFile(target,'utf8')).id).toBe('222');expect((await configureLocalPlugin(target,source)).changed).toBe(false);
});
it('refuses malformed generated ID without touching the installed plugin',async()=>{
 const root=await mkdtemp(resolve('.bridge','plugin invalid '));const target=resolve(root,'manifest.json'),source=resolve(root,'generated.json');await writeFile(target,JSON.stringify({id:'111',main:'main.js',ui:'index.html'}));await writeFile(source,JSON.stringify({id:'x'}));await expect(configureLocalPlugin(target,source)).rejects.toThrow();expect(JSON.parse(await readFile(target,'utf8')).id).toBe('111');expect((await readdir(root)).sort()).toEqual(['generated.json','manifest.json']);
});
