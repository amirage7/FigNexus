import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,mkdir,readdir,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installConfig,uninstallConfig,planConfig} from '../scripts/distribution/config.mjs';
import {stageDistribution} from '../scripts/distribution/build.mjs';

const options=(home:string)=>({codexHome:home,installDir:resolve(home,'程序 files'),dataDir:resolve(home,'用户 data')});
describe('portable Windows Codex installation',()=>{
 it('preserves other settings, backs up and makes reinstall idempotent',async()=>{
  const home=await mkdtemp(resolve('.bridge','install 测试 '));
  const original='# user comments\nmodel = "example"\n[mcp_servers.other]\ncommand = "other.exe"\n';
  await writeFile(resolve(home,'config.toml'),original);
  const first=await installConfig(options(home));
  expect(await readFile(first.backup!,'utf8')).toBe(original);
  const changed=await readFile(resolve(home,'config.toml'),'utf8');
  expect(changed.startsWith(original)).toBe(true);
  expect(changed).toContain('startup_timeout_sec = 90');
  expect(changed).toContain('FIGMA_BRIDGE_DATA_DIR');
  expect((await installConfig(options(home))).changed).toBe(false);
  expect(await readFile(resolve(home,'config.toml'),'utf8')).toBe(changed);
  await uninstallConfig(options(home));
  expect(await readFile(resolve(home,'config.toml'),'utf8')).toBe(original);
 });
 it('rejects a foreign entry without modifying anything',async()=>{
  const home=await mkdtemp(resolve('.bridge','conflict '));
  const original='[mcp_servers."figma-ai-bridge"]\ncommand="stranger.exe"\n';
  await writeFile(resolve(home,'config.toml'),original);
  await expect(installConfig(options(home))).rejects.toThrow(/conflict/i);
  await expect(uninstallConfig(options(home))).rejects.toThrow(/identity/i);
  expect(await readFile(resolve(home,'config.toml'),'utf8')).toBe(original);
  expect(await readdir(home)).toEqual(['config.toml']);
 });
 it('handles quoted names and multiline strings containing fake headers',async()=>{
  const home=await mkdtemp(resolve('.bridge','quoted '));
  const original='note="""\n[mcp_servers.figma-ai-bridge]\nfake=true\n"""\n[mcp_servers."other.tool"]\ncommand="other"\n';
  await writeFile(resolve(home,'config.toml'),original);
  await installConfig(options(home));
  await uninstallConfig(options(home));
  expect(await readFile(resolve(home,'config.toml'),'utf8')).toBe(original);
 });
 it('rejects invalid and inline target tables without loss',()=>{
  expect(()=>planConfig('bad = [',options('test'))).toThrow();
  expect(()=>planConfig('mcp_servers = { figma-ai-bridge = { command = "x" } }',options('test'))).toThrow(/conflict/i);
 });
 it('retains user data and refuses an edited managed command',async()=>{
  const home=await mkdtemp(resolve('.bridge','identity '));
  await mkdir(options(home).dataDir);
  await writeFile(resolve(options(home).dataDir,'token'),'retained');
  await installConfig(options(home));
  const path=resolve(home,'config.toml');
  await writeFile(path,(await readFile(path,'utf8')).replace('runtime/node.exe','runtime/foreign.exe'));
  await expect(uninstallConfig(options(home))).rejects.toThrow(/identity/i);
  expect(await readFile(resolve(options(home).dataDir,'token'),'utf8')).toBe('retained');
 });
 it('upgrades only a verified previous managed installation',async()=>{
  const home=await mkdtemp(resolve('.bridge','upgrade '));
  const previous=options(home);
  await installConfig(previous);
  const next={...previous,installDir:resolve(home,'new version'),previous};
  await installConfig(next);
  expect(await readFile(resolve(home,'config.toml'),'utf8')).toContain('new version/runtime/node.exe');
  await uninstallConfig(next);
  expect(await readFile(resolve(home,'config.toml'),'utf8')).toBe('');
 });
});
describe('runtime-included distribution',()=>{
 it('contains only builds, production packages, licensed runtime and install entries',async()=>{
  const root=await mkdtemp(resolve('.bridge','bundle 源码 '));
  for(const path of ['apps/bridge-server/dist','apps/pairing-helper/dist','packages/mcp-server/dist','apps/figma-plugin/dist','node_modules/prod','node_modules/dev','scripts/distribution']) await mkdir(resolve(root,path),{recursive:true});
  await writeFile(resolve(root,'package.json'),JSON.stringify({version:'1.0.0',dependencies:{prod:'1.0.0'},devDependencies:{dev:'1.0.0'}}));
  for(const name of ['prod','dev']) {await writeFile(resolve(root,'node_modules',name,'package.json'),JSON.stringify({name,version:'1.0.0',main:'index.js'}));await writeFile(resolve(root,'node_modules',name,'index.js'),'module.exports={}');}
  for(const path of ['apps/bridge-server/dist/index.js','apps/pairing-helper/dist/index.js','packages/mcp-server/dist/index.js','apps/figma-plugin/dist/main.js','apps/figma-plugin/dist/index.html']) await writeFile(resolve(root,path),'// compiled');
  await writeFile(resolve(root,'apps/figma-plugin/dist/manifest.json'),JSON.stringify({id:'123456789',networkAccess:{allowedDomains:['none']}}));
  await writeFile(resolve(root,'apps/figma-plugin/dist/manifest.json.backup-local'),'private identity');
  await writeFile(resolve(root,'node.exe'),'runtime');await writeFile(resolve(root,'LICENSE'),'licensed');
  const output=resolve(root,'output');
  await stageDistribution({root,output,nodePath:resolve(root,'node.exe'),nodeLicense:resolve(root,'LICENSE'),installerSource:resolve('scripts/distribution')});
  expect(await readFile(resolve(output,'runtime/node.exe'),'utf8')).toBe('runtime');
  expect(await readdir(resolve(output,'node_modules'))).toEqual(['prod']);
  expect(await readdir(output)).not.toContain('.bridge');
  const manifest=JSON.parse(await readFile(resolve(output,'plugin/manifest.production-candidate.json'),'utf8'));
  expect(manifest.networkAccess.allowedDomains).toContain('http://localhost:3055');
  expect(manifest.networkAccess.reasoning).toContain('local');
  expect(manifest.id).toBeUndefined();
  expect(JSON.parse(await readFile(resolve(output,'plugin/manifest.json'),'utf8')).id).toBeUndefined();
  expect(await readdir(resolve(output,'plugin'))).not.toContain('manifest.json.backup-local');
  expect(await readFile(resolve(output,'install.cmd'),'utf8')).toContain('%~dp0');
  expect(await readFile(resolve(output,'Windows安装说明.md'),'utf8')).toContain('FigNexus Windows 安装指南');
  expect(await readFile(resolve(output,'images/setup.svg'),'utf8')).toContain('FigNexus');
  expect(await readFile(resolve(output,'apps/pairing-helper/dist/index.js'),'utf8')).toBe('// compiled');
  await unlink(resolve(root,'apps/pairing-helper/dist/index.js'));
  await expect(stageDistribution({root,output:resolve(root,'missing helper'),nodePath:resolve(root,'node.exe'),nodeLicense:resolve(root,'LICENSE'),installerSource:resolve('scripts/distribution')})).rejects.toThrow(/pairing-helper/);
 });
 it('preserves conflicting production dependency versions under their consumer',async()=>{
  const root=await mkdtemp(resolve('.bridge','nested dependencies '));
  for(const path of ['apps/bridge-server/dist','apps/pairing-helper/dist','packages/mcp-server/dist','apps/figma-plugin/dist','node_modules/a/node_modules/string_decoder','node_modules/string_decoder'])await mkdir(resolve(root,path),{recursive:true});
  await writeFile(resolve(root,'package.json'),JSON.stringify({version:'1',dependencies:{string_decoder:'1',a:'1'}}));
  for(const [path,name,version,deps] of [['string_decoder','string_decoder','1',{}],['a','a','1',{string_decoder:'2'}],['a/node_modules/string_decoder','string_decoder','2',{}]] as const){await writeFile(resolve(root,'node_modules',path,'package.json'),JSON.stringify({name,version,dependencies:deps}));}
  for(const path of ['apps/bridge-server/dist/index.js','apps/pairing-helper/dist/index.js','packages/mcp-server/dist/index.js','apps/figma-plugin/dist/main.js','apps/figma-plugin/dist/index.html'])await writeFile(resolve(root,path),'build');
  await writeFile(resolve(root,'apps/figma-plugin/dist/manifest.json'),'{}');await writeFile(resolve(root,'node.exe'),'node');await writeFile(resolve(root,'LICENSE'),'license');
  const output=resolve(root,'output');
  await stageDistribution({root,output,nodePath:resolve(root,'node.exe'),nodeLicense:resolve(root,'LICENSE'),installerSource:resolve('scripts/distribution')});
  expect(JSON.parse(await readFile(resolve(output,'node_modules/a/node_modules/string_decoder/package.json'),'utf8')).version).toBe('2');
  expect(JSON.parse(await readFile(resolve(output,'node_modules/string_decoder/package.json'),'utf8')).version).toBe('1');
 });
});
it('includes the single first-use entry and direct manifest import instructions',async()=>{
 const root=await mkdtemp(resolve('.bridge','onboarding bundle '));for(const path of ['apps/bridge-server/dist','apps/pairing-helper/dist','packages/mcp-server/dist','apps/figma-plugin/dist'])await mkdir(resolve(root,path),{recursive:true});await writeFile(resolve(root,'package.json'),JSON.stringify({version:'0.3.1',dependencies:{}}));for(const path of ['apps/bridge-server/dist/index.js','apps/pairing-helper/dist/index.js','packages/mcp-server/dist/index.js','apps/figma-plugin/dist/main.js','apps/figma-plugin/dist/index.html'])await writeFile(resolve(root,path),'build');await writeFile(resolve(root,'apps/figma-plugin/dist/manifest.json'),'{}');await writeFile(resolve(root,'node.exe'),'node');await writeFile(resolve(root,'LICENSE'),'license');const output=resolve(root,'output');await stageDistribution({root,output,nodePath:resolve(root,'node.exe'),nodeLicense:resolve(root,'LICENSE'),installerSource:resolve('scripts/distribution')});expect(await readFile(resolve(output,'开始使用.cmd'),'utf8')).toContain('start.ps1');expect(await readFile(resolve(output,'setup-plugin.ps1'),'utf8')).toContain('Import plugin from manifest');expect(await readFile(resolve(output,'start.ps1'),'utf8')).toContain('connect.ps1');
});
