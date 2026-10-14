import { UiMessage, Result,isWriteRequest, type Request,type RequestProgress } from '@bridge/protocol';
import { createExecutor } from './executor';
import {PairingStorage} from './pairing-storage';
import {PanelPreferences} from './panel';
declare const __html__: string;
const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let writeEnabled = false;
function context() { return { instanceId, document: { id: figma.root.id, name: figma.root.name }, page: { id: figma.currentPage.id, name: figma.currentPage.name }, writeEnabled }; }
let deleteApproved = false;
let activeRequestId:string|undefined;
const progress=(stage:RequestProgress['stage'],requestId=activeRequestId)=>{if(requestId)figma.ui.postMessage({type:'progress',requestId,stage});};
const execute = createExecutor(figma, () => writeEnabled, context, () => deleteApproved,stage=>progress(stage));
const confirmations = new Map<string, { confirmationId: string; fingerprint: string; pageId: string; expires: number; approved: boolean; request: Extract<Request,{method:'execute'}> }>();
const cache = new Map<string, { fingerprint: string; result: Result }>();
// Never evict executed write IDs. Evicted results must not permit a second mutation.
const writes = new Map<string, string>();
let pending = Promise.resolve();
let executingConfirmation: {requestId:string;confirmationId:string}|undefined;
async function run(p: Request) {
  const fingerprint = JSON.stringify(p), previous = cache.get(p.requestId);
  if (previous) {
    figma.ui.postMessage(previous.fingerprint === fingerprint ? previous.result : { type: 'result', requestId: p.requestId, ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Request ID has a different payload' } }); return;
  }
  if (writes.has(p.requestId)) {
    figma.ui.postMessage({ type: 'result', requestId: p.requestId, ok: false, error: { code: writes.get(p.requestId) === fingerprint ? 'WRITE_RESULT_EXPIRED' : 'IDEMPOTENCY_CONFLICT', message: 'Write ID already used; inspect nodes rather than replaying' } }); return;
  }
  const waiting = confirmations.get(p.requestId);
  if(waiting && waiting.expires >= Date.now() && waiting.fingerprint !== fingerprint){
    figma.ui.postMessage({type:'result',requestId:p.requestId,ok:false,error:{code:'IDEMPOTENCY_CONFLICT',message:'Pending confirmation belongs to another payload'}});return;
  }
  if (isWriteRequest(p)) {
    if (p.method==='execute' && writeEnabled && p.params.operations.some(op => op.op === 'delete')) {
      let grant = confirmations.get(p.requestId);
      if (!grant || grant.fingerprint !== fingerprint || grant.pageId !== figma.currentPage.id || grant.expires < Date.now() || !grant.approved) {
        for (const [id, item] of confirmations) if (item.expires < Date.now()) confirmations.delete(id);
        if (confirmations.size >= 8 && !confirmations.has(p.requestId)) { figma.ui.postMessage({ type: 'result', requestId: p.requestId, ok: false, error: { code: 'CONFIRMATION_CAPACITY', message: 'Too many pending confirmations' } }); return; }
        if (!grant || grant.expires < Date.now() || grant.pageId !== figma.currentPage.id) grant = { confirmationId: `${instanceId}-${Date.now()}-${Math.random().toString(36).slice(2)}`, fingerprint, pageId: figma.currentPage.id, expires: Date.now()+300000, approved: false, request:p };
        confirmations.set(p.requestId, grant);
        panel.reveal();
        figma.ui.postMessage({ type: 'confirmation', requestId: p.requestId, confirmationId: grant.confirmationId, targets: p.params.operations.filter(op => op.op === 'delete').map(op => op.target) });
        figma.ui.postMessage({ type: 'result', requestId: p.requestId, ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirm and execute this exact batch in the local plugin within 5 minutes; retrieve the final result using the SAME requestId and payload' } }); return;
      }
    }
    if (writes.size >= 256) { figma.ui.postMessage({ type: 'result', requestId: p.requestId, ok: false, error: { code: 'WRITE_CAPACITY', message: '256 write request IDs reached; restart plugin after recording results' } }); return; }
    writes.set(p.requestId, fingerprint);
    const approvedGrant=confirmations.get(p.requestId);
    deleteApproved = approvedGrant?.approved ?? false;
    if(deleteApproved&&approvedGrant)executingConfirmation={requestId:p.requestId,confirmationId:approvedGrant.confirmationId};
  }
  let result: Result;
  activeRequestId=p.requestId;progress('started');
  try {
    const data = p.method === 'ping' ? { pong: true as const, context: context() } : await execute(p.method, p.params);
    result = Result.parse({ type: 'result', requestId: p.requestId, ok: true, data });
  } catch (e) { result = { type: 'result', requestId: p.requestId, ok: false, error: { code: 'OPERATION_FAILED', message: (e instanceof Error ? e.message : 'Unknown error').slice(0,512) } }; }
  finally {progress('result-ready');activeRequestId=undefined; deleteApproved = false; executingConfirmation=undefined; confirmations.delete(p.requestId); }
  cache.set(p.requestId, { fingerprint, result });
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  figma.ui.postMessage(result);
}
figma.showUI(__html__, { width: 420, height: 470, themeColors: true });
const panel=new PanelPreferences(figma.clientStorage,(w,h)=>figma.ui.resize(w,h),message=>figma.ui.postMessage(message));
const pairing=new PairingStorage(figma.clientStorage,message=>figma.ui.postMessage(message));
figma.ui.onmessage = raw => {
  const parsed = UiMessage.safeParse(raw);
  if (!parsed.success) return;
  const p = parsed.data;
  if(p.type==='panel-load'){const blocked=Array.from(confirmations.values()).some(grant=>!grant.approved&&grant.pageId===figma.currentPage.id&&grant.expires>Date.now());void panel.load(blocked);return;}
  if(p.type==='panel-mode'){const blocked=Array.from(confirmations.values()).some(grant=>!grant.approved&&grant.pageId===figma.currentPage.id&&grant.expires>Date.now());void panel.setCompact(p.compact,blocked);return;}
  if(p.type==='pairing-load'||p.type==='pairing-save'||p.type==='pairing-forget'){void pairing.handle(p);return;}
  if (p.type === 'context-request') figma.ui.postMessage({ type: 'context', context: context() });
  else if (p.type === 'set-write') { writeEnabled = p.enabled; if (!writeEnabled) confirmations.clear(); figma.ui.postMessage({ type: 'context', context: context() }); }
  else if (p.type === 'confirm-delete') {
    const grant = confirmations.get(p.requestId);
    const acknowledge = (state:'accepted'|'cancelled'|'invalid') => figma.ui.postMessage({type:'confirmation_state',requestId:p.requestId,confirmationId:p.confirmationId,state});
    if(executingConfirmation?.requestId===p.requestId&&executingConfirmation.confirmationId===p.confirmationId){acknowledge('accepted');return;}
    if (!writeEnabled || !grant || grant.confirmationId !== p.confirmationId || grant.expires <= Date.now() || grant.pageId !== figma.currentPage.id) { acknowledge('invalid'); return; }
    // Acceptance starts execution; later cancel/duplicate clicks cannot retract it.
    if(grant.approved){acknowledge('accepted');return;}
    if (!p.approved) { confirmations.delete(p.requestId); acknowledge('cancelled'); return; }
    acknowledge('accepted');
    grant.approved = true;
    pending = pending.then(async () => {
      if (!writeEnabled || confirmations.get(p.requestId) !== grant || grant.pageId !== figma.currentPage.id || grant.expires <= Date.now() || JSON.stringify(grant.request) !== grant.fingerprint) {
        if(confirmations.get(p.requestId)===grant)confirmations.delete(p.requestId);
        acknowledge('invalid'); return;
      }
      await run(grant.request);
    }).catch(() => acknowledge('invalid'));
  }
  else {progress('received',p.requestId);pending = pending.then(() => run(p)).catch(() => {});}
};
let observedPage:PageNode|undefined;
const invalidate=()=>execute.invalidatePreview();
function watchPage(){observedPage?.off?.('nodechange',invalidate);observedPage=figma.currentPage;observedPage.on?.('nodechange',invalidate);}
watchPage();
figma.on('currentpagechange', () => {invalidate();watchPage();figma.ui.postMessage({ type: 'context', context: context() });});
