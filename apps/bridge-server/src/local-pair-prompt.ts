import type {QuickPairing} from './quick-pairing';
/** One human confirmation per explicit click; never auto-grants a credential. */
export class LocalPairPrompt{
 private active?:{id:string;controller:AbortController};private nextStart=0;private closed=false;private work:Promise<void>=Promise.resolve();
 constructor(private pairing:QuickPairing,private approvalSecret:string,private confirm:(code:string,signal:AbortSignal)=>Promise<boolean>,private now=Date.now){}
 start(){
  if(this.closed)throw Error('PAIR_CLOSED');if(this.active)throw Error('PAIR_BUSY');if(this.now()<this.nextStart)throw Error('PAIR_RATE_LIMIT');
  const challenge=this.pairing.start(),controller=new AbortController();this.active={id:challenge.id,controller};this.nextStart=this.now()+10000;
  this.work=Promise.resolve().then(()=>this.confirm(challenge.code,controller.signal)).then(approved=>{
   if(approved&&!controller.signal.aborted&&!this.closed)this.pairing.approve(challenge.id,challenge.code,this.approvalSecret);else this.pairing.cancel(challenge.id);
  }).catch(()=>{this.pairing.cancel(challenge.id);}).finally(()=>{if(this.active?.id===challenge.id)this.active=undefined;});
  return challenge;
 }
 cancel(id:string,secret:string){this.pairing.cancelRequest(id,secret);if(this.active?.id===id)this.active.controller.abort();}
 idle(){return this.work;}
 close(){this.closed=true;if(this.active){this.active.controller.abort();this.pairing.cancel(this.active.id);}}
}
