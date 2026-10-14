import {PairingCommand,SavedPairing,type PairingState} from '@bridge/protocol';
const KEY='ai-bridge-pairing-v1';
export class PairingStorage{
  private queue=Promise.resolve();
  constructor(private storage:ClientStorageAPI,private post:(message:PairingState)=>void){}
  handle(command:PairingCommand){
    this.queue=this.queue.then(async()=>{
      const p=PairingCommand.parse(command),action=p.type==='pairing-load'?'load':p.type==='pairing-save'?'save':'forget';
      try{
        if(p.type==='pairing-load'){
          const parsed=SavedPairing.safeParse(await this.storage.getAsync(KEY));
          this.post({type:'pairing-state',requestId:p.requestId,action,saved:parsed.success,...(parsed.success?{token:parsed.data.token,mode:parsed.data.mode}:{})});
        }else if(p.type==='pairing-save'){
          await this.storage.setAsync(KEY,SavedPairing.parse({version:1,token:p.token,mode:p.mode}));this.post({type:'pairing-state',requestId:p.requestId,action,saved:true});
        }else{
          await this.storage.deleteAsync(KEY);this.post({type:'pairing-state',requestId:p.requestId,action,saved:false});
        }
      }catch{this.post({type:'pairing-state',requestId:p.requestId,action,error:'STORAGE_UNAVAILABLE'});}
    }).catch(()=>{});
    return this.queue;
  }
}
