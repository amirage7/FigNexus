import type {PairingCommand,PairingState} from '@bridge/protocol';
type Mode='ws'|'http';
export type PairingView={token:string;mode:Mode;remember:boolean;saved:boolean;notice:string};
type Connection={connect:(token:string,mode:Mode)=>Promise<void>;disconnect:()=>Promise<void>};
export class PairingSession{
  private view:PairingView={token:'',mode:'ws',remember:true,saved:false,notice:''};
  private generation=0;private counter=0;private ready=false;private started=false;private autoPair?:{token:string;mode:Mode};private autoStarted=false;
  private pendingLoad?:{requestId:string;sequence:number;generation:number};
  private storageRequests=new Map<string,{action:'save'|'forget';sequence:number;pair?:{token:string;mode:Mode}}>();
  private appliedStorageSequence=0;private persistedPair?:{token:string;mode:Mode};
  private connectionIntent?:{token:string;mode:Mode};private connected=false;
  constructor(private connection:Connection,private post:(command:PairingCommand)=>void,private render:(view:PairingView)=>void){}
  private emit(){this.render({...this.view});}
  private invalidate(){this.generation++;this.autoPair=undefined;}
  private cancelAuto(){if(this.autoStarted){this.autoStarted=false;void this.connection.disconnect().catch(()=>{});}}
  private send(action:PairingState['action']){
    const sequence=++this.counter,requestId=`pairing-${sequence}`;
    if(action==='load')this.pendingLoad={requestId,sequence,generation:this.generation};
    else{this.storageRequests.set(requestId,{action,sequence,...(action==='save'?{pair:{token:this.view.token,mode:this.view.mode}}:{})});if(this.storageRequests.size>128)this.storageRequests.delete(this.storageRequests.keys().next().value!);}
    this.post(action==='save'?{type:'pairing-save',requestId,token:this.view.token,mode:this.view.mode}:{type:action==='load'?'pairing-load':'pairing-forget',requestId});
  }
  start(){if(this.started)return;this.started=true;this.send('load');}
  contextReady(){this.ready=true;this.autoConnect();}
  private autoConnect(){
    if(!this.ready||!this.autoPair)return;const pair=this.autoPair;this.autoPair=undefined;this.autoStarted=true;const generation=this.generation;
    this.connectionIntent=pair;
    void this.connection.connect(pair.token,pair.mode).catch(()=>{if(this.generation===generation){this.view.notice='自动连接失败，请检查 Bridge 或重新配对。';this.emit();}});
  }
  receive(message:PairingState){
    const load=this.pendingLoad,storage=this.storageRequests.get(message.requestId);
    const pending=message.action==='load'&&load?.requestId===message.requestId?load:storage?.action===message.action?storage:undefined;
    if(!pending)return;
    if(message.action==='load')this.pendingLoad=undefined;else this.storageRequests.delete(message.requestId);
    if(pending.sequence<this.appliedStorageSequence)return;this.appliedStorageSequence=pending.sequence;
    const staleLoad=message.action==='load'&&load?.generation!==this.generation;
    if(message.error){this.view.notice=message.action==='forget'?'未能清除本机配对，下次仍可能自动连接，请重试。':message.action==='save'?'未能保存本机配对；当前连接可继续使用。':'未能读取本机配对，请重新配对。';this.emit();return;}
    if(message.saved!==undefined)this.view.saved=message.saved;
    if(message.action==='save')this.persistedPair=storage?.pair;
    if(message.action==='forget')this.persistedPair=undefined;
    if(staleLoad){this.emit();return;}
    if(message.action==='load'&&message.saved&&message.token&&message.mode){this.view.token=message.token;this.view.mode=message.mode;this.autoPair={token:message.token,mode:message.mode};this.persistedPair=this.autoPair;this.view.notice='已载入本机配对。';}
    else this.view.notice=message.action==='save'?'已记住本机配对，下次自动连接。':message.action==='forget'?'已清除本机配对。':'';
    this.emit();this.autoConnect();
  }
  setToken(token:string){this.cancelAuto();this.invalidate();this.connectionIntent=undefined;this.connected=false;this.view.token=token.trim();this.emit();}
  setMode(mode:Mode){this.cancelAuto();this.invalidate();this.connectionIntent=undefined;this.connected=false;this.view.mode=mode;this.emit();}
  setRemember(remember:boolean){this.invalidate();this.view.remember=remember;this.emit();if(!remember)this.send('forget');else if(this.connected&&this.connectionIntent)this.connectionEstablished(this.connectionIntent.token,this.connectionIntent.mode);}
  connectionEstablished(token:string,mode:Mode){
    if(!this.connectionIntent||this.connectionIntent.token!==token||this.connectionIntent.mode!==mode||this.view.token!==token||this.view.mode!==mode)return;
    this.connected=true;if(!this.view.remember)return;
    const pending=[...this.storageRequests.values()],lastForget=Math.max(0,...pending.filter(p=>p.action==='forget').map(p=>p.sequence));
    if(!lastForget&&this.persistedPair?.token===token&&this.persistedPair.mode===mode)return;
    if(pending.some(p=>p.action==='save'&&p.sequence>lastForget&&p.pair?.token===token&&p.pair.mode===mode))return;
    this.send('save');
  }
  async connect(){
    this.cancelAuto();this.invalidate();const {token,mode}=this.view;
    this.connectionIntent={token,mode};this.connected=false;
    await this.connection.connect(token,mode);
  }
  async disconnect(){this.invalidate();this.autoStarted=false;this.connectionIntent=undefined;this.connected=false;await this.connection.disconnect();}
  async forget(){this.invalidate();this.autoStarted=false;this.connectionIntent=undefined;this.connected=false;this.view.token='';this.view.notice='正在清除本机配对…';this.emit();this.send('forget');await this.connection.disconnect();}
}
