import {expect,it} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuditStore} from '../apps/bridge-server/src/audit';
const context={instanceId:'design-run',document:{id:'d',name:'Doc'},page:{id:'old',name:'Old'},writeEnabled:true};
it('journals a declared page switch and accepts exact replay on its resulting page only',async()=>{
  const audit=new AuditStore(await mkdtemp(join(tmpdir(),'phase6-audit-')));await audit.init();
  const request:any={type:'request',requestId:'switch',method:'design',params:{action:'page_switch',expectedPageId:'old',pageId:'new'}};
  await audit.start(context,request);expect(audit.status().recent).toHaveLength(1);
  const result:any={type:'result',requestId:'switch',ok:true,data:{context:{...context,page:{id:'new',name:'New'}},complete:true,created:[],refs:{},completed:[0],backups:[],skipped:[],design:{action:'page_switch',pageId:'new',previousPageId:'old'}}};
  await audit.result(context.instanceId,result);expect(audit.status().recent[0].state).toBe('complete');
  await expect(audit.start(result.data.context,request)).resolves.toBeUndefined();
  await expect(audit.start({...context,page:{id:'other',name:'Other'}},request)).rejects.toThrow();
});
it('rejects an unrelated page change and does not journal design reads',async()=>{
  const audit=new AuditStore(await mkdtemp(join(tmpdir(),'phase6-audit-')));await audit.init();
  await audit.start(context,{type:'request',requestId:'read',method:'design',params:{action:'pages_list',cursor:0,limit:20}});
  expect(audit.status().recent).toHaveLength(0);
  await audit.start(context,{type:'request',requestId:'create',method:'design',params:{action:'page_create',expectedPageId:'old',name:'Test'}});
  const data:any={context:{...context,page:{id:'other',name:'Other'}},complete:true,created:[],refs:{},completed:[0],backups:[],skipped:[],design:{action:'page_create',pageId:'other'}};
  await expect(audit.result(context.instanceId,{type:'result',requestId:'create',ok:true,data})).rejects.toThrow('context mismatch');
});
it('records unapplied variable values with changed history as partial',async()=>{
 const audit=new AuditStore(await mkdtemp(join(tmpdir(),'phase6-audit-')));await audit.init();
 await audit.start(context,{type:'request',requestId:'history-failure',method:'design',params:{action:'variable_set',expectedPageId:'old',variableId:'v',value:100}} as any);
 await audit.result(context.instanceId,{type:'result',requestId:'history-failure',ok:true,data:{context,complete:false,created:[],refs:{},completed:[],backups:[],skipped:[],failed:{index:0,code:'SET_FAILED',message:'setter failed'},design:{action:'variable_set',variableId:'v',value:99,historyChanged:true,history:[]}}} as any);
 expect(audit.status().recent[0].state).toBe('partial');
});
