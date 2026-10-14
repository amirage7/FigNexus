import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { FileContext, Request, Result,isWriteRequest } from '@bridge/protocol';

const id = z.string().min(1).max(128);
const Entry = z.object({ version:z.literal(1), instanceId:id, documentId:id, pageId:id, requestId:id,
  method:z.enum(['execute','restore_backup','design','image_upload']), operations:z.array(z.enum(['create','update','clone','reparent','reorder','delete','layout','restore_backup','design','image_upload'])).max(25),
  designAction:z.string().min(1).max(64).optional(),targetPageId:id.optional(),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/), startedAt:z.string().datetime(), updatedAt:z.string().datetime(),
  state:z.enum(['started','waiting_confirmation','complete','partial','failed','uncertain']),
  completed:z.array(z.number().int().min(0).max(24)).max(25), backupIds:z.array(id).max(25)
}).strict();
export type AuditEntry = z.infer<typeof Entry>;
export class AuditValidationError extends Error {
  constructor(message:string){super(message);this.name='AuditValidationError';}
}
const terminal = (entry:AuditEntry) => ['complete','partial','failed'].includes(entry.state);
const key = (instanceId:string, requestId:string) => JSON.stringify([instanceId,requestId]);
function canonical(value:unknown):string {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
const missing = (error:unknown) => (error as NodeJS.ErrnoException).code==='ENOENT';

/** Single-process, bounded, append-only audit journal. No request payload is retained. */
export class AuditStore {
  private entries = new Map<string,AuditEntry>();
  private queue:Promise<void> = Promise.resolve();
  private ready=false;
  private healthy=true;
  private readonly maxBytes:number;
  private readonly history:number;
  private readonly capacity=5000;
  constructor(private readonly directory:string, options:{maxBytes?:number;history?:number}={}) {
    this.maxBytes=options.maxBytes??5*1024*1024;this.history=options.history??5;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<512||!Number.isSafeInteger(this.history)||this.history<1||this.history>5)throw new Error('Invalid audit bounds');
  }
  private file(index=0){return join(this.directory,index?`audit.${index}.jsonl`:'audit.jsonl');}
  private remember(entry:AuditEntry){
    const k=key(entry.instanceId,entry.requestId);
    if(!this.entries.has(k)&&this.entries.size>=this.capacity){
      const old=[...this.entries].find(([,v])=>terminal(v));
      if(!old)throw new Error('Audit capacity exhausted');
      this.entries.delete(old[0]);
    }
    this.entries.set(k,entry);
  }
  async init():Promise<void>{
    if(this.ready)return;
    try {
      await mkdir(this.directory,{recursive:true});this.entries.clear();
      const checkpointPath=join(this.directory,'audit.next');
      const paths=[...Array.from({length:this.history+1},(_,i)=>this.file(this.history-i)),checkpointPath];
      let checkpointFound=false;
      for(const path of paths){
        let raw:Buffer;
        try{if((await stat(path)).size>this.maxBytes)throw new Error('Audit file exceeds bounds');raw=await readFile(path);}catch(e){if(missing(e))continue;throw e;}
        if(path===checkpointPath)checkpointFound=true;
        const end=raw.lastIndexOf(10)+1;
        if(path===checkpointPath&&(end<raw.length||raw.length===0))throw new Error('Incomplete audit checkpoint');
        // Only an uncommitted trailing fragment may be discarded; complete bad lines fail closed.
        if(end<raw.length){const handle=await open(path,'r+');try{await handle.truncate(end);await handle.sync();}finally{await handle.close();}}
        for(const line of raw.subarray(0,end).toString('utf8').split('\n')){
          if(!line)continue;const entry=Entry.parse(JSON.parse(line));const old=this.entries.get(key(entry.instanceId,entry.requestId));
          if(old&&(old.fingerprint!==entry.fingerprint||old.pageId!==entry.pageId||old.documentId!==entry.documentId))throw new Error('Conflicting audit records');
          if(!old||!terminal(old))this.remember(entry);
        }
      }
      if(checkpointFound){
        // A crash may leave the old active log in place. Archive it before promotion;
        // replacing it directly would erase completed records on the next restart.
        let activeExists=false;
        try{activeExists=(await stat(this.file())).isFile();}catch(e){if(!missing(e))throw e;}
        if(activeExists){
          // An interrupted rename sequence leaves a gap; fill only that gap instead
          // of shifting already-moved archives again and prematurely dropping history.
          let gap=0;
          for(let i=1;i<=this.history;i++){try{await stat(this.file(i));}catch(e){if(!missing(e))throw e;gap=i;break;}}
          if(!gap){gap=this.history;await unlink(this.file(this.history));}
          for(let i=gap-1;i>=0;i--)await rename(this.file(i),this.file(i+1));
        }
        // If rotation already archived active, its absence prevents another shift.
        await rename(checkpointPath,this.file());
      }
      for(const [k,entry] of this.entries)if(!terminal(entry))this.entries.set(k,{...entry,state:'uncertain'});
      this.ready=true;this.healthy=true;
    }catch(e){this.healthy=false;throw e;}
  }
  private serial(action:()=>Promise<void>):Promise<void>{
    const next=this.queue.then(async()=>{if(!this.ready)throw new Error('Audit store is not initialized');await action();});
    this.queue=next.catch(()=>{});return next;
  }
  private async append(entry:AuditEntry){
    try {
      const line=JSON.stringify(Entry.parse(entry))+'\n';
      const bytes=Buffer.byteLength(line);
      if(bytes>this.maxBytes)throw new Error('Audit record exceeds bounds');
      let size=0;try{const info=await stat(this.file());if(!info.isFile())throw new Error('Audit path is not a file');size=info.size;}catch(e){if(!missing(e))throw e;}
      if(size+bytes>this.maxBytes){
        // Carry all unresolved requests before evicting history, so rotation cannot lose uncertainty.
        const carry=[...this.entries.values()].filter(x=>!terminal(x)&&key(x.instanceId,x.requestId)!==key(entry.instanceId,entry.requestId)).map(x=>JSON.stringify(x)+'\n').join('');
        if(Buffer.byteLength(carry)+bytes>this.maxBytes)throw new Error('Audit unresolved capacity exhausted');
        // Synced checkpoint exists before history changes. init recovers it after interruption.
        const temp=join(this.directory,'audit.next');const checkpoint=await open(temp,'w');
        try{try{await checkpoint.writeFile(carry+line);await checkpoint.sync();}finally{await checkpoint.close();}}
        catch(e){try{await unlink(temp);}catch{this.ready=false;}throw e;}
        try{
          try{await unlink(this.file(this.history));}catch(e){if(!missing(e))throw e;}
          for(let i=this.history-1;i>=0;i--){try{await rename(this.file(i),this.file(i+1));}catch(e){if(!missing(e))throw e;}}
          await rename(temp,this.file());
        }catch(e){this.ready=false;throw e;}
      }else{
        const handle=await open(this.file(),'a');
        try{await handle.writeFile(line);await handle.sync();}
        catch(e){try{await handle.truncate(size);await handle.sync();}catch{this.ready=false;}throw e;}
        finally{await handle.close();}
      }
      this.remember(entry);this.healthy=true;
    }catch(e){this.healthy=false;throw e;}
  }
  async start(context:FileContext,request:Request):Promise<void>{
    return this.serial(async()=>{
      const ctx=FileContext.parse(context);const req=Request.parse(request);
      if(!isWriteRequest(req))return;
      const fingerprint=createHash('sha256').update(canonical(req)).digest('hex');
      const old=this.entries.get(key(ctx.instanceId,req.requestId));
      if(old){
        const replaySwitch=req.method==='design'&&req.params.action==='page_switch'&&old.pageId===req.params.expectedPageId&&old.targetPageId===ctx.page.id;
        if(old.fingerprint!==fingerprint||old.pageId!==ctx.page.id&&!replaySwitch||old.documentId!==ctx.document.id)throw new Error('Audit request conflict');return;
      }
      if(req.method==='design'&&'expectedPageId'in req.params&&req.params.expectedPageId!==ctx.page.id)throw Error('Audit page scope mismatch');
      if(req.method==='image_upload'&&req.params.expectedPageId!==ctx.page.id)throw Error('Audit page scope mismatch');
      if(this.entries.size>=this.capacity&&![...this.entries.values()].some(terminal))throw new Error('Audit capacity exhausted');
      const now=new Date().toISOString();
      if(req.method!=='execute'&&req.method!=='restore_backup'&&req.method!=='design'&&req.method!=='image_upload')throw Error('Unknown write method');
      await this.append({version:1,instanceId:ctx.instanceId,documentId:ctx.document.id,pageId:ctx.page.id,requestId:req.requestId,method:req.method,operations:req.method==='execute'?req.params.operations.map(x=>x.op):[req.method],...(req.method==='design'?{designAction:req.params.action,...(req.params.action==='page_switch'?{targetPageId:req.params.pageId}:{})}:{}),fingerprint,startedAt:now,updatedAt:now,state:'started',completed:[],backupIds:[]});
    });
  }
  async result(instanceId:string,result:Result):Promise<void>{
    return this.serial(async()=>{
      const checked=Result.safeParse(result);
      if(!checked.success)throw new AuditValidationError('Audit result schema mismatch');
      const parsed=checked.data;
      const old=this.entries.get(key(instanceId,parsed.requestId));if(!old)return;
      let pageChanged=false;
      if(parsed.ok){
        if(!('context' in parsed.data)||!parsed.data.context||parsed.data.context.instanceId!==instanceId||parsed.data.context.document.id!==old.documentId)throw new AuditValidationError('Audit result context mismatch');
        pageChanged=parsed.data.context.page.id!==old.pageId;
        if(old.method==='design'&&(!('design'in parsed.data)||parsed.data.design.action!==old.designAction))throw new AuditValidationError('Audit design result mismatch');
        if(old.method==='image_upload'&&!('image'in parsed.data))throw new AuditValidationError('Audit image result mismatch');
        const validSwitch=old.designAction==='page_switch'&&'design'in parsed.data&&parsed.data.design.pageId===old.targetPageId&&parsed.data.design.previousPageId===old.pageId&&parsed.data.context.page.id===old.targetPageId;
        if(pageChanged&&!validSwitch&&(!('complete' in parsed.data)||parsed.data.complete))throw new AuditValidationError('Audit result context mismatch');
        if(validSwitch)pageChanged=false;
      }
      if(terminal(old))return;
      let state:AuditEntry['state'];let completed=old.completed;let backupIds=old.backupIds;
      if(!parsed.ok){
        if(['IDEMPOTENCY_CONFLICT','REQUEST_CONFLICT'].includes(parsed.error.code))return;
        state=parsed.error.code==='CONFIRMATION_REQUIRED'?'waiting_confirmation':['WRITE_RESULT_EXPIRED','CONFIRMATION_CAPACITY'].includes(parsed.error.code)?'uncertain':'failed';
      }
      else if('complete' in parsed.data){
        completed=parsed.data.completed??parsed.data.created.map(x=>x.index);backupIds=parsed.data.backups?.map(x=>x.backupId)??[];
        state=parsed.data.complete?'complete':completed.length>0||backupIds.length>0||parsed.data.created.length>0||('design'in parsed.data&&parsed.data.design.historyChanged===true)?'partial':'failed';
        if(pageChanged)state='uncertain';
      }
      else throw new AuditValidationError('Audit result shape mismatch');
      await this.append({...old,state,completed,backupIds,updatedAt:new Date().toISOString()});
    });
  }
  async uncertain(instanceId:string,requestId:string):Promise<void>{return this.serial(async()=>{const old=this.entries.get(key(instanceId,requestId));if(old&&!terminal(old)&&old.state!=='uncertain')await this.append({...old,state:'uncertain',updatedAt:new Date().toISOString()});});}
  unresolved(cursor=0,limit=20):{entries:AuditEntry[];nextCursor:number|null;total:number}{
    const start=Number.isFinite(cursor)?Math.max(0,Math.min(5000,Math.floor(cursor))):0;
    const count=Number.isFinite(limit)?Math.max(1,Math.min(50,Math.floor(limit))):20;
    const values=[...this.entries.values()].filter(x=>!terminal(x));
    const entries=values.slice(start,start+count).map(x=>({...x,operations:[...x.operations],completed:[...x.completed],backupIds:[...x.backupIds]}));
    return {entries,nextCursor:start+entries.length<values.length?start+entries.length:null,total:values.length};
  }
  status(){const values=[...this.entries.values()];return {healthy:this.healthy,pending:values.filter(x=>x.state==='started'||x.state==='waiting_confirmation').length,uncertain:values.filter(x=>x.state==='uncertain').length,retained:values.length,recent:values.slice(-50).map(x=>({...x,operations:[...x.operations],completed:[...x.completed],backupIds:[...x.backupIds]}))};}
  async flush():Promise<void>{await this.queue;}
}
