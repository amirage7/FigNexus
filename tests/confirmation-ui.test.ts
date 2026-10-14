import {expect,it} from 'vitest';
import {ClientMessage,MainMessage} from '../packages/protocol/src/index';
import {reduceDeleteState} from '../apps/figma-plugin/src/confirmation-ui';
const confirmation={type:'confirmation' as const,requestId:'delete',confirmationId:'grant',targets:['target']};
const accepted={type:'confirmation_state' as const,requestId:'delete',confirmationId:'grant',state:'accepted' as const};
it('waits for matching main acknowledgement and never calls acceptance completion',()=>{
  const waiting=reduceDeleteState({notice:''},confirmation);
  expect(waiting.confirmation).toEqual(confirmation);
  expect(reduceDeleteState(waiting,{...accepted,confirmationId:'old'})).toBe(waiting);
  const executing=reduceDeleteState(waiting,accepted);
  expect(executing.confirmation).toBeUndefined();expect(executing.notice).toContain('正在执行');expect(executing.notice).not.toContain('已完成');
  const result:any={type:'result',requestId:'delete',ok:true,data:{complete:true,backups:[{backupId:'backup'}]}};
  expect(reduceDeleteState(executing,result).notice).toContain('删除已完成');
});
it('reports invalid and cancelled acknowledgement and rejects partial success',()=>{
  const waiting=reduceDeleteState({notice:''},confirmation);
  expect(reduceDeleteState(waiting,{...accepted,state:'invalid'}).notice).toContain('失效');
  expect(reduceDeleteState(waiting,{...accepted,state:'cancelled'}).notice).toContain('取消');
  const executing=reduceDeleteState(waiting,accepted);
  const partial:any={type:'result',requestId:'delete',ok:true,data:{complete:false,backups:[]}};
  expect(reduceDeleteState(executing,partial).notice).toContain('未全部完成');
  expect(reduceDeleteState(executing,{...partial,requestId:'unrelated'})).toBe(executing);
});
it('does not clear a new confirmation when the previous execution completes',()=>{
  let state=reduceDeleteState(reduceDeleteState({notice:''},confirmation),accepted);
  const next={...confirmation,requestId:'next',confirmationId:'next-grant'};
  state=reduceDeleteState(state,next);
  state=reduceDeleteState(state,{type:'result',requestId:'delete',ok:false,error:{code:'FAILED',message:'failed'}});
  expect(state.confirmation).toEqual(next);expect(state.notice).toContain('未完成');
});
it('accepts acknowledgement only on the main-to-UI channel',()=>{
  expect(MainMessage.safeParse(accepted).success).toBe(true);
  expect(ClientMessage.safeParse(accepted).success).toBe(false);
  expect(MainMessage.safeParse({...accepted,approved:true}).success).toBe(false);
});
it('ignores a changed-payload conflict while awaiting the accepted exact batch',()=>{
  const state=reduceDeleteState(reduceDeleteState({notice:''},confirmation),accepted);
  expect(reduceDeleteState(state,{type:'result',requestId:'delete',ok:false,error:{code:'IDEMPOTENCY_CONFLICT',message:'another payload'}})).toBe(state);
});
