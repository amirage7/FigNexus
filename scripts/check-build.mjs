// Portable checker. Optional argv[2] is the local pnpm CLI .mjs path.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
for(const args of [['check'],['--filter','@bridge/plugin','check:main'],['test'],['build']]) {
  const result=process.argv[2]
    ? spawnSync(process.execPath,[process.argv[2],...args],{cwd,stdio:'inherit',windowsHide:true})
    : spawnSync(process.platform==='win32'?'pnpm.cmd':'pnpm',args,{cwd,stdio:'inherit',windowsHide:true,shell:process.platform==='win32'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
