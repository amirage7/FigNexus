import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
const Pending=z.object({id:z.string().uuid(),code:z.string().regex(/^\d{6}$/),expires:z.number().int()}).strict();
export async function approvePairing(raw:unknown,credentials:{token:string;approvalSecret:string},confirm:(code:string)=>Promise<boolean>,fetcher:typeof fetch=fetch){
  const p=Pending.parse(raw);if(p.expires<=Date.now()||p.expires>Date.now()+125000)throw Error('配对请求已过期。');
  if(!await confirm(p.code))return false;
  if(p.expires<=Date.now())throw Error('配对请求已过期，请在 Figma 重新发起。');
  const response=await fetcher('http://127.0.0.1:3055/v1/pair/approve',{method:'POST',headers:{Authorization:`Bearer ${credentials.token}`,'x-figma-pair-approval':credentials.approvalSecret,'Content-Type':'application/json'},body:JSON.stringify({id:p.id,code:p.code}),signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok||!(await response.json()).approved)throw Error('本机确认失败，请重试。');return true;
}
export async function confirmWindows(code:string,signal?:AbortSignal){
  if(!/^\d{6}$/.test(code)||process.platform!=='win32')throw Error('Windows confirmation required');
  const script="Add-Type -AssemblyName System.Windows.Forms; $answer=[System.Windows.Forms.MessageBox]::Show(('请核对 Figma 插件里的配对码：'+$env:FIGMA_PAIR_CODE+[Environment]::NewLine+'仅在数字相同且由你发起时允许配对。'),'FigNexus 本机配对',[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Question,[System.Windows.Forms.MessageBoxDefaultButton]::Button2); if($answer -eq [System.Windows.Forms.DialogResult]::Yes){Write-Output 'APPROVE'}else{Write-Output 'DENY'}";
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,FIGMA_PAIR_CODE:code},timeout:125000,signal});
  return stdout.trim()==='APPROVE';
}
