import {BackupMetadata,ListBackupsInput,RestoreInput,type FileContext,type ExecuteResult} from '@bridge/protocol';
import type {z} from 'zod';
export const BACKUP_KEY='ai-bridge-backup-v1',CONTAINER_KEY='ai-bridge-backup-container-v1';
type Editable=FrameNode|TextNode|RectangleNode|EllipseNode|LineNode|VectorNode;
type Api=Pick<PluginAPI,'currentPage'|'getNodeByIdAsync'|'commitUndo'>;
const fail=(code:string):never=>{throw Error(code);};
function onPage(n:BaseNode,page:PageNode){for(let p:BaseNode|null=n;p;p=p.parent)if(p.id===page.id)return true;return false;}
export function backupMetadata(n:BaseNode,page:PageNode){
  if(n.removed||!['FRAME','TEXT','RECTANGLE','ELLIPSE','LINE','VECTOR'].includes(n.type)||!onPage(n,page)||n.parent?.type!=='FRAME'||n.parent.parent?.id!==page.id||n.parent.getPluginData(CONTAINER_KEY)!=='1')return undefined;
  try{const m=BackupMetadata.parse(JSON.parse(n.getPluginData(BACKUP_KEY)));return m.backupId===n.id&&m.pageId===page.id?m:undefined;}catch{return undefined;}
}
export function listBackups(api:Api,raw:unknown,context:()=>FileContext){
  const p=ListBackupsInput.parse(raw),page=api.currentPage,backups:z.infer<typeof BackupMetadata>[]=[];
  let scanned=0,matched=0,nextCursor:number|null=null,truncated=false;
  outer:for(const container of page.children){
    if(scanned>=10000){truncated=true;break;}scanned++;
    if(container.type!=='FRAME'||container.getPluginData(CONTAINER_KEY)!=='1')continue;
    for(const node of container.children){
      if(scanned>=10000){truncated=true;break outer;}scanned++;
      const metadata=backupMetadata(node,page);if(!metadata)continue;
      if(matched++<p.cursor)continue;
      if(backups.length===p.limit){nextCursor=p.cursor+backups.length;break outer;}
      backups.push(metadata);
    }
  }
  return {context:context(),backups,nextCursor,truncated,scanned};
}
function parentGuard(n:BaseNode|null,page:PageNode):PageNode|FrameNode{
  if(!n||n.removed||!onPage(n,page)||!['PAGE','FRAME'].includes(n.type))return fail('INVALID_PARENT');
  for(let p:BaseNode|null=n;p&&p.type!=='DOCUMENT';p=p.parent){if(p.type==='INSTANCE'||('locked'in p&&p.locked)||p.getPluginData?.(CONTAINER_KEY)==='1')return fail('PARENT_NOT_EDITABLE');}
  return n as PageNode|FrameNode;
}
function boundedTree(node:BaseNode,depth=0):number{
  if(depth>20)fail('BACKUP_TOO_DEEP');let size=1;
  if('children'in node)for(const child of node.children){size+=boundedTree(child,depth+1);if(size>500)fail('BACKUP_TOO_LARGE');}return size;
}
export async function restoreBackup(api:Api,raw:unknown,canWrite:()=>boolean,context:()=>FileContext):Promise<z.infer<typeof ExecuteResult>>{
  const p=RestoreInput.parse(raw),page=api.currentPage,deadline=Date.now()+15000;
  const check=()=>{if(!canWrite())fail('WRITE_DISABLED');if(api.currentPage.id!==page.id)fail('PAGE_CHANGED');if(Date.now()>deadline)fail('EXECUTION_DEADLINE');};
  check();const backup=await api.getNodeByIdAsync(p.backupId);check();
  if(!backup||!backupMetadata(backup,page))fail('INVALID_BACKUP');
  const parentNode=await api.getNodeByIdAsync(p.parentId);check();const parent=parentGuard(parentNode,page);
  if(!backupMetadata(backup!,page))fail('INVALID_BACKUP');boundedTree(backup!);
  const index=p.index??parent.children.length;if(index>parent.children.length)fail('INDEX_OUT_OF_RANGE');
  let copy:Editable|undefined;
  try{
    check();copy=(backup as Editable).clone();copy.setPluginData(BACKUP_KEY,'');copy.setPluginData(CONTAINER_KEY,'');parent.insertChild(index,copy);
  }catch(e){
    if(copy&&!copy.removed)copy.remove();
    return {context:context(),complete:false,created:[],refs:{},completed:[],backups:[],skipped:[],failed:{index:0,code:'RESTORE_FAILED',message:(e instanceof Error?e.message:'RESTORE_FAILED').slice(0,512)}};
  }
  api.commitUndo();return {context:context(),complete:true,created:[{index:0,id:copy.id,type:copy.type}],refs:{},completed:[0],backups:[],skipped:[]};
}
