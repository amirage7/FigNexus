import { PreviewInput, ChunkInput,type RequestProgress } from '@bridge/protocol';
import type { z } from 'zod';
type Api = Pick<PluginAPI, 'currentPage' | 'getNodeByIdAsync' | 'base64Encode'>;
type Metadata = { exportId:string;nodeId:string;totalBytes:number;chunks:number };
type NativeJob = {
  key:string;pageId:string;epoch:number;waiters:number;settled:boolean;
  promise:Promise<Metadata>;result?:Metadata;
};
export class PreviewManager {
  private exports = new Map<string, { bytes: Uint8Array; expires: number;pageId:string;epoch:number }>();
  private native?:NativeJob;
  private epoch=0;
  constructor(private api: Api,private progress:(stage:RequestProgress['stage'])=>void=()=>{},private timeoutMs=15000) {}
  invalidate() {
    this.epoch++;
    this.exports.clear();
    // A pending Figma promise cannot be cancelled. Keep its slot occupied until it settles.
    if(this.native?.settled)this.native=undefined;
  }
  private valid(job:NativeJob) {
    if(this.api.currentPage.id!==job.pageId)throw Error('PAGE_CHANGED');
    if(this.epoch!==job.epoch)throw Error('PREVIEW_INVALIDATED');
  }
  private prune() {
    for(const [id,item] of this.exports)
      if(item.expires<Date.now() || item.pageId!==this.api.currentPage.id || item.epoch!==this.epoch)this.exports.delete(id);
    const job=this.native;
    if(job?.settled && (!job.result || !this.exports.has(job.result.exportId)))this.native=undefined;
  }
  async export(raw: z.input<typeof PreviewInput>) {
    const p=PreviewInput.parse(raw),pageId=this.api.currentPage.id;
    this.prune();
    const key=JSON.stringify([pageId,p.nodeId,p.maxSize,this.epoch]);
    let job=this.native;
    if(job && job.key!==key) {
      if(!job.settled)throw Error('PREVIEW_NATIVE_BUSY');
      this.native=undefined;job=undefined;
    }
    if(!job) {
      job={key,pageId,epoch:this.epoch,waiters:0,settled:false,promise:undefined!};
      this.native=job;
      const current=job;
      // Start after attaching the waiting request, so progress belongs to an active waiter.
      current.promise=Promise.resolve().then(async()=>{
        const emit=(stage:RequestProgress['stage'])=>{if(current.waiters>0 && current.epoch===this.epoch && current.pageId===this.api.currentPage.id)this.progress(stage);};
        emit('node-loading');
        const node=await this.api.getNodeByIdAsync(p.nodeId);
        this.valid(current);emit('node-ready');
        let inside=false;
        for(let n:BaseNode|null=node;n;n=n.parent)if(n.id===pageId)inside=true;
        if(!node || node.type!=='FRAME' || !inside)throw Error('FRAME_REQUIRED');
        const scale=Math.min(1,p.maxSize/Math.max(node.width,node.height));
        emit('export-loading');
        const bytes=await node.exportAsync({format:'PNG',constraint:{type:'SCALE',value:scale},contentsOnly:true,useAbsoluteBounds:true});
        this.valid(current);
        if(!bytes.length || bytes.length>2097152)throw Error('PREVIEW_TOO_LARGE');
        emit('export-ready');
        const exportId=`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        this.prune();
        if(this.exports.size>=2)this.exports.delete(this.exports.keys().next().value!);
        this.exports.set(exportId,{bytes,expires:Date.now()+300000,pageId,epoch:current.epoch});
        const result={exportId,nodeId:node.id,totalBytes:bytes.length,chunks:Math.ceil(bytes.length/36000)};
        current.result=result;
        return result;
      });
      void current.promise.then(()=>{current.settled=true;},()=>{
        current.settled=true;if(this.native===current)this.native=undefined;
      });
    }
    const current=job;current.waiters++;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([current.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('PREVIEW_PENDING')),this.timeoutMs);})]);
      this.valid(current);
      // Only the retry that receives the retained PNG consumes this job. Future calls export afresh.
      if(this.native===current)this.native=undefined;
      return result;
    }finally{current.waiters--;if(timer!==undefined)clearTimeout(timer);}
  }
  chunk(raw: z.input<typeof ChunkInput>) {
    const p=ChunkInput.parse(raw);
    this.prune();
    const item=this.exports.get(p.exportId);
    if(!item){throw Error('PREVIEW_EXPIRED');}
    if(p.index>=Math.ceil(item.bytes.length/36000))throw Error('CHUNK_OUT_OF_RANGE');
    return {exportId:p.exportId,index:p.index,base64:this.api.base64Encode(item.bytes.slice(p.index*36000,(p.index+1)*36000))};
  }
}
