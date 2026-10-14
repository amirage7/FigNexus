import type { Confirmation, ConfirmationState, Result } from '@bridge/protocol';
import type { z } from 'zod';
export type LocalDeleteState = { confirmation?: z.infer<typeof Confirmation>; pending?: {requestId:string;confirmationId:string}; notice:string };
export function reduceDeleteState(state:LocalDeleteState,message:z.infer<typeof Confirmation>|z.infer<typeof ConfirmationState>|Result):LocalDeleteState {
  if(message.type==='confirmation')return {...state,confirmation:message};
  if(message.type==='confirmation_state'){
    const active=state.confirmation?.requestId===message.requestId&&state.confirmation?.confirmationId===message.confirmationId;
    const pending=state.pending?.requestId===message.requestId&&state.pending?.confirmationId===message.confirmationId;
    if(!active&&!pending)return state;
    if(message.state==='accepted')return {...state,confirmation:active?undefined:state.confirmation,pending:{requestId:message.requestId,confirmationId:message.confirmationId},notice:'确认已接受，正在执行删除…'};
    return {...state,confirmation:active?undefined:state.confirmation,pending:pending?undefined:state.pending,notice:message.state==='cancelled'?'已取消删除。':'确认已失效，未获得执行授权。请重新发起请求。'};
  }
  if(message.requestId!==state.pending?.requestId)return state;
  if(!message.ok&&message.error.code==='IDEMPOTENCY_CONFLICT')return state;
  const complete=message.ok&&'complete' in message.data&&message.data.complete;
  return {...state,pending:undefined,notice:complete?'删除已完成，修改前备份已保留。':message.ok?'操作未全部完成，请查看执行结果。':`删除未完成：${message.error.message}`};
}
