import {expect,it} from 'vitest';
import {approvePairing} from '../apps/pairing-helper/src/confirm';
const challenge=()=>({id:'00000000-0000-4000-8000-000000000001',code:'123456',expires:Date.now()+10000});
it('never requests approval after local refusal',async()=>{
  let sends=0;const fetcher:any=async()=>{sends++;return {ok:true,json:async()=>({approved:true})};};
  expect(await approvePairing(challenge(),{token:'token',approvalSecret:'secret'},async()=>false,fetcher)).toBe(false);expect(sends).toBe(0);
});
it('sends the separate approval credential only after matching-code confirmation',async()=>{
  const requests:any[]=[];const fetcher:any=async(url:any,opts:any)=>{requests.push({url,opts});return {ok:true,json:async()=>({approved:true})};};
  expect(await approvePairing(challenge(),{token:'token',approvalSecret:'secret'},async code=>code==='123456',fetcher)).toBe(true);
  expect(requests[0].opts.headers['x-figma-pair-approval']).toBe('secret');expect(requests[0].opts.body).not.toContain('secret');
});
it('rejects malformed or expired challenges before asking for confirmation',async()=>{
  let confirms=0;const confirm=async()=>{confirms++;return true;};
  await expect(approvePairing({...challenge(),code:'injected'}, {token:'token',approvalSecret:'secret'},confirm)).rejects.toThrow();
  await expect(approvePairing({...challenge(),expires:Date.now()-1},{token:'token',approvalSecret:'secret'},confirm)).rejects.toThrow('过期');expect(confirms).toBe(0);
});
