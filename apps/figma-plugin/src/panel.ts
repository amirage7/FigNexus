import {z} from 'zod';
const KEY='ai-bridge-panel-v1';
const SavedPanel=z.object({version:z.literal(1),compact:z.boolean()}).strict();
type State={type:'panel-state';compact:boolean;error?:'STORAGE_UNAVAILABLE'};
export class PanelPreferences{
 private compact=false;
 private generation=0;
 private loading?:Promise<void>;
 private queue=Promise.resolve();
 constructor(private storage:ClientStorageAPI,private resize:(width:number,height:number)=>void,private post:(state:State)=>void){}
 private apply(compact:boolean){
  if(this.compact!==compact){this.resize(compact?220:420,compact?44:470);this.compact=compact;}
  this.post({type:'panel-state',compact:this.compact});
 }
 load(confirmationPending=false){
  if(confirmationPending){this.reveal();return Promise.resolve();}
  if(this.loading)return this.loading;
  const generation=this.generation;
  this.loading=(async()=>{try{const saved=SavedPanel.safeParse(await this.storage.getAsync(KEY));if(generation===this.generation)this.apply(saved.success?saved.data.compact:false);}catch{if(generation===this.generation)this.post({type:'panel-state',compact:this.compact,error:'STORAGE_UNAVAILABLE'});}})();
  return this.loading;
 }
 setCompact(compact:boolean,confirmationPending=false){
  if(compact&&confirmationPending){this.reveal();return Promise.resolve();}
  const generation=++this.generation;this.apply(compact);
  this.queue=this.queue.then(async()=>{try{await this.storage.setAsync(KEY,{version:1,compact});}catch{if(generation===this.generation)this.post({type:'panel-state',compact:this.compact,error:'STORAGE_UNAVAILABLE'});}});
  return this.queue;
 }
 reveal(){++this.generation;this.apply(false);}
}
