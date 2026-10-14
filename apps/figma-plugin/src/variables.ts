import {type FileContext,type ExecuteResult} from '@bridge/protocol';
import {DesignParams,VariableValue,type DesignOutput} from '../../../packages/protocol/src/design';
import {z} from 'zod';
import {BACKUP_KEY,CONTAINER_KEY} from './backups';
export const OWNER_KEY='ai-bridge-variable-owner-v1',HISTORY_KEY='ai-bridge-variable-history-v1';
type Api=Pick<PluginAPI,'variables'|'currentPage'|'getNodeByIdAsync'|'createFrame'|'loadFontAsync'|'commitUndo'>;
type Result=z.infer<typeof ExecuteResult>&{design:DesignOutput};
type Editable=FrameNode|TextNode|RectangleNode|EllipseNode;
type Value=z.infer<typeof VariableValue>;
const History=z.array(z.object({id:z.string().min(1).max(128),createdAt:z.string().datetime(),value:VariableValue}).strict()).max(20);
const fail=(code:string):never=>{throw Error(code);};
const managed=(v:Variable|VariableCollection)=>!v.remote&&v.getPluginData(OWNER_KEY)==='1';
function supportedType(type:VariableResolvedDataType):type is 'COLOR'|'FLOAT'|'STRING'|'BOOLEAN'{return ['COLOR','FLOAT','STRING','BOOLEAN'].includes(type);}
function exact(type:VariableResolvedDataType,value:unknown):Value{
 if(!supportedType(type))fail('VARIABLE_TYPE_UNSUPPORTED');
 const v=VariableValue.parse(value);
 if(type==='COLOR'?typeof v!=='object':type==='FLOAT'?typeof v!=='number':type==='STRING'?typeof v!=='string':typeof v!=='boolean')fail('VARIABLE_TYPE_MISMATCH');
 return v;
}
function direct(v:Variable,c:VariableCollection):Value{return exact(v.resolvedType,v.valuesByMode[c.defaultModeId]);}
function sameValue(a:Value,b:Value){return typeof a==='object'&&typeof b==='object'?a.r===b.r&&a.g===b.g&&a.b===b.b&&(a.a??1)===(b.a??1):a===b;}
function owner(v:Variable|undefined,c:VariableCollection|null){
 if(!c||!managed(c)||v&&!managed(v))fail('VARIABLE_NOT_MANAGED');
 if(c!.modes.length!==1||c!.modes[0].modeId!==c!.defaultModeId)fail('VARIABLE_MULTIMODE_UNSUPPORTED');
 if(v&&v.variableCollectionId!==c!.id)fail('VARIABLE_COLLECTION_MISMATCH');
 if(v)direct(v,c!);
}
function history(v:Variable){const raw=v.getPluginData(HISTORY_KEY);if(raw.length>60000)fail('VARIABLE_HISTORY_INVALID');return History.parse(raw?JSON.parse(raw):[]);}
function record(v:Variable,value:Value){
 const rows=history(v),id='vh-'+Array.from({length:4},()=>Math.floor(Math.random()*0x100000000).toString(16).padStart(8,'0')).join('');
 if(rows.some(r=>r.id===id))fail('VARIABLE_HISTORY_ID_COLLISION');
 const saved=[...rows,{id,createdAt:new Date().toISOString(),value}].slice(-20);let raw=JSON.stringify(saved);
 // JSON escaping can expand a valid 2048-character STRING substantially.
 while(raw.length>60000&&saved.length>1){saved.shift();raw=JSON.stringify(saved);}
 if(raw.length>60000)fail('VARIABLE_HISTORY_TOO_LARGE');return raw;
}
function editable(n:BaseNode|null,page:PageNode):Editable{
 if(!n||n.removed||!['FRAME','TEXT','RECTANGLE','ELLIPSE'].includes(n.type))return fail('INVALID_TARGET');
 let onPage=false;for(let p:BaseNode|null=n;p;p=p.parent){if(p.id===page.id)onPage=true;if(p.type==='INSTANCE'||('locked'in p&&p.locked)||p.getPluginData?.(CONTAINER_KEY)==='1')fail('TARGET_NOT_EDITABLE');}
 if(!onPage)fail('INVALID_TARGET');return n as Editable;
}
function treeSize(n:BaseNode,depth=0):number{
 if(depth>20)fail('BACKUP_TOO_DEEP');let size=1;if('children'in n)for(const child of n.children){size+=treeSize(child,depth+1);if(size>500)fail('BACKUP_TOO_LARGE');}return size;
}
function bindingGuard(n:Editable,field:string,type:VariableResolvedDataType){
 const required=field==='fills'?'COLOR':field==='characters'?'STRING':field==='visible'?'BOOLEAN':'FLOAT';if(required!==type)fail('BINDING_TYPE_MISMATCH');
 if(field==='characters'&&n.type!=='TEXT')fail('TEXT_REQUIRED');
 if(field==='cornerRadius'&&!['FRAME','RECTANGLE'].includes(n.type))fail('CORNER_RADIUS_UNSUPPORTED');
 if(['itemSpacing','paddingTop','paddingBottom','paddingLeft','paddingRight'].includes(field)&&(n.type!=='FRAME'||n.layoutMode==='NONE'))fail('AUTO_LAYOUT_REQUIRED');
 if(field==='fills'&&(!Array.isArray(n.fills)||!n.fills.length||n.fills.length>4||n.fills.some(p=>p.type!=='SOLID')))fail('SOLID_FILL_REQUIRED');
}
export function createVariables(api:Api,canWrite:()=>boolean,context:()=>FileContext){
 return async(raw:unknown):Promise<Result>=>{
  const p=DesignParams.parse(raw),page=api.currentPage,write='expectedPageId'in p,deadline=Date.now()+15000;
  const result:Result={context:context(),complete:false,created:[],refs:{},completed:[],backups:[],skipped:[],design:{action:p.action}};
  const check=()=>{if(write&&!canWrite())fail('WRITE_DISABLED');if(write&&p.expectedPageId!==page.id)fail('PAGE_CHANGED');if(api.currentPage.id!==page.id)fail('PAGE_CHANGED');if(Date.now()>deadline)fail('EXECUTION_DEADLINE');};
  let newCollection:VariableCollection|undefined,newVariable:Variable|undefined,mutated=false,observe:(()=>void)|undefined,rollbackHistory:(()=>void)|undefined;
  const complete=()=>{if(!result.completed!.includes(0))result.completed!.push(0);};
  const getCollection=async(id:string)=>{const c=await api.variables.getVariableCollectionByIdAsync(id);check();return c;};
  const getVariable=async(id:string)=>{const v=await api.variables.getVariableByIdAsync(id);check();if(!v)fail('VARIABLE_NOT_FOUND');const c=await getCollection(v!.variableCollectionId);return {v:v!,c:c!};};
  try{
   check();
   if(p.action==='variables_list'){
    const collections=await api.variables.getLocalVariableCollectionsAsync();check();const variables=await api.variables.getLocalVariablesAsync();check();
    const total=collections.length+variables.length,scanned=Math.min(10000,total),end=Math.min(p.cursor+p.limit,scanned),cs:NonNullable<DesignOutput['collections']>=[],vs:NonNullable<DesignOutput['variables']>=[];
    const map=new Map(collections.slice(0,10000).map(c=>[c.id,c]));
    for(let i=p.cursor;i<end;i++){
     if(i<collections.length){const c=collections[i];cs.push({id:c.id,name:c.name.slice(0,512),defaultModeId:c.defaultModeId,managed:managed(c)});}
     else{
      const v=variables[i-collections.length],c=map.get(v.variableCollectionId);if(!supportedType(v.resolvedType))continue;
      let value:Value|undefined;try{if(c)value=direct(v,c);}catch{}
      vs.push({id:v.id,name:v.name.slice(0,512),collectionId:v.variableCollectionId,resolvedType:v.resolvedType,managed:managed(v),...(value!==undefined?{value}:{})});
     }
    }
    Object.assign(result.design,{collections:cs,variables:vs,scanned,truncated:total>10000,nextCursor:end<scanned?end:null});
   }else if(p.action==='collection_create'){
    check();newCollection=api.variables.createVariableCollection(p.name);mutated=true;check();newCollection.setPluginData(OWNER_KEY,'1');check();owner(undefined,newCollection);result.design.collectionId=newCollection.id;complete();
   }else if(p.action==='variable_create'){
    const c=await getCollection(p.collectionId);owner(undefined,c);const value=exact(p.resolvedType,p.value);check();newVariable=api.variables.createVariable(p.name,c!,p.resolvedType);mutated=true;check();newVariable.setPluginData(OWNER_KEY,'1');check();newVariable.setValueForMode(c!.defaultModeId,value);check();owner(newVariable,c);Object.assign(result.design,{variableId:newVariable.id,collectionId:c!.id,value:direct(newVariable,c!)});complete();
   }else if(p.action==='variable_history'){
    const {v,c}=await getVariable(p.variableId);owner(v,c);result.design.variableId=v.id;result.design.history=history(v);
   }else if(p.action==='variable_set'||p.action==='variable_restore'){
    const {v,c}=await getVariable(p.variableId);owner(v,c);const old=direct(v,c),value=exact(v.resolvedType,p.action==='variable_set'?p.value:history(v).find(h=>h.id===p.historyId)?.value);
    result.design.variableId=v.id;result.design.collectionId=c.id;
    check();owner(v,c);const priorHistory=v.getPluginData(HISTORY_KEY),recordedHistory=record(v,old);
    rollbackHistory=()=>{
     let unchanged=false;try{unchanged=sameValue(direct(v,c),old);}catch{}
     // An applied value must keep its pre-write history, including applied-then-threw failures.
     if(!unchanged)return;
     try{
      if(v.getPluginData(HISTORY_KEY)===recordedHistory){check();owner(v,c);v.setPluginData(HISTORY_KEY,priorHistory);}
     }catch{}
     if(v.getPluginData(HISTORY_KEY)!==priorHistory){
      result.design.historyChanged=true;result.design.history=history(v);result.design.value=direct(v,c);
     }
    };
    mutated=true;v.setPluginData(HISTORY_KEY,recordedHistory);check();
    observe=()=>{const current=direct(v,c);result.design.value=current;if(sameValue(current,value))complete();};
    v.setValueForMode(c.defaultModeId,value);observe();check();if(!result.completed!.length)fail('VARIABLE_VALUE_READBACK_FAILED');
   }else if(p.action==='variable_bind'){
    const {v,c}=await getVariable(p.variableId);owner(v,c);const n=editable(await api.getNodeByIdAsync(p.nodeId),page);check();bindingGuard(n,p.field,v.resolvedType);
    if(p.field==='characters'&&n.type==='TEXT'){
     const fonts=n.characters.length?n.getRangeAllFontNames(0,n.characters.length):typeof n.fontName==='object'?[n.fontName]:[];if(!fonts.length)fail('FONT_UNRESOLVED');
     const unique=new Map(fonts.map(font=>[JSON.stringify(font),font]));for(const font of unique.values()){await api.loadFontAsync(font);check();editable(n,page);owner(v,c);}
    }
    check();editable(n,page);owner(v,c);bindingGuard(n,p.field,v.resolvedType);treeSize(n);
    const parent=n.parent;if(!parent||!('children'in parent))fail('INVALID_PARENT');const index=(parent as ChildrenMixin).children.findIndex(child=>child.id===n.id);let copy:Editable|undefined,container:FrameNode|undefined;
    try{
     check();copy=n.clone();mutated=true;check();container=api.createFrame();check();container.name=`AI Bridge Backups · ${new Date().toISOString()}`;container.setPluginData(CONTAINER_KEY,'1');container.visible=false;container.locked=true;
     check();copy.setPluginData(BACKUP_KEY,JSON.stringify({version:1,backupId:copy.id,nodeId:n.id,parentId:parent!.id,index,pageId:page.id,createdAt:new Date().toISOString()}));container.appendChild(copy);
     result.backups!.push({nodeId:n.id,backupId:copy.id,parentId:parent!.id,index});
    }catch(error){if(copy&&!copy.removed)copy.remove();if(container&&!container.removed)container.remove();throw error;}
    Object.assign(result.design,{variableId:v.id,collectionId:c.id,field:p.field,value:direct(v,c)});
    observe=()=>{
     // Native FRAME/RECTANGLE cornerRadius bindings read back as four individual aliases.
     const aliases=p.field==='fills'?(Array.isArray(n.fills)?n.fills.map(paint=>paint.type==='SOLID'?paint.boundVariables?.color:undefined):[]):p.field==='cornerRadius'&&['FRAME','RECTANGLE'].includes(n.type)?(['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius'] as const).map(field=>n.boundVariables?.[field]):[n.boundVariables?.[p.field]];
     if(aliases.length&&aliases.every(a=>a?.id===v.id)){result.design.boundVariableId=v.id;complete();}
    };
    check();editable(n,page);owner(v,c);bindingGuard(n,p.field,v.resolvedType);
    if(p.field==='fills')n.fills=(n.fills as SolidPaint[]).map(paint=>api.variables.setBoundVariableForPaint(paint,'color',v));else n.setBoundVariable(p.field,v);
    mutated=true;observe();check();if(!result.design.boundVariableId)fail('VARIABLE_BINDING_READBACK_FAILED');
   }else fail('UNSUPPORTED_VARIABLE_ACTION');
   if(mutated)api.commitUndo();check();result.complete=true;
  }catch(error){
   if(observe)try{observe();}catch{}
   if(rollbackHistory)try{rollbackHistory();}catch{}
   // Only objects created by this request are eligible for cleanup. Native backups are retained.
   if(newVariable){try{newVariable.remove();result.completed=[];delete result.design.variableId;delete result.design.value;}catch{result.design.variableId=newVariable.id;try{const value=VariableValue.safeParse(Object.values(newVariable.valuesByMode)[0]);if(value.success)result.design.value=value.data;}catch{}}}
   if(newCollection){try{newCollection.remove();result.completed=[];delete result.design.collectionId;}catch{result.design.collectionId=newCollection.id;}}
   result.failed={index:0,code:'VARIABLE_FAILED',message:(error instanceof Error?error.message:'VARIABLE_FAILED').slice(0,512)};
   if(mutated)try{api.commitUndo();}catch{}
  }
  result.context=context();return result;
 };
}
