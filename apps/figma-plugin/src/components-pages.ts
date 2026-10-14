import {DesignParams,type DesignOutput} from '../../../packages/protocol/src/design';
import type {FileContext} from '../../../packages/protocol/src/common';
import {BACKUP_KEY,CONTAINER_KEY} from './backups';

type Api=Pick<PluginAPI,'root'|'currentPage'|'getNodeByIdAsync'|'createComponentFromNode'|'createPage'|'setCurrentPageAsync'|'on'|'off'|'commitUndo'>;
type Evidence={context:FileContext;complete:boolean;created:{index:number;id:string;type:string}[];refs:Record<string,string>;completed:number[];backups:[];skipped:number[];design:DesignOutput;failed?:{index:number;code:string;message:string}};
const fail=(code:string):never=>{throw Error(code);};
function onPage(node:BaseNode,page:PageNode){for(let n:BaseNode|null=node;n;n=n.parent)if(n.id===page.id)return true;return false;}
function managed(node:BaseNode){return !!node.getPluginData?.(BACKUP_KEY)||node.getPluginData?.(CONTAINER_KEY)==='1';}
function editable(node:BaseNode|null,page:PageNode){
  if(!node||node.removed||!onPage(node,page))return fail('INVALID_TARGET');
  for(let n:BaseNode|null=node;n&&n.type!=='DOCUMENT';n=n.parent)if(n.type==='INSTANCE'||('locked'in n&&n.locked)||managed(n))fail('TARGET_NOT_EDITABLE');
  return node;
}
function parent(node:BaseNode|null,page:PageNode):FrameNode|PageNode{
  const n=editable(node,page);if(n.type!=='FRAME'&&n.type!=='PAGE')return fail('INVALID_PARENT');return n;
}
function boundedTree(node:BaseNode,depth=0,budget={count:0}){
  if(depth>20)fail('SOURCE_TOO_DEEP');if(++budget.count>500)fail('SOURCE_TOO_LARGE');
  if(managed(node))fail('SOURCE_CONTAINS_BACKUP');
  if('children'in node)for(const child of node.children)boundedTree(child,depth+1,budget);
}

export function createComponentsPages(api:Api,canWrite:()=>boolean,context:()=>FileContext){
  return async(raw:unknown):Promise<Evidence>=>{
    const p=DesignParams.parse(raw),page=api.currentPage;
    const result=(design:DesignOutput):Evidence=>({context:context(),complete:true,created:[],refs:{},completed:[],backups:[],skipped:[],design});
    if(p.action==='pages_list'){
      const total=Math.min(api.root.children.length,10000),pages=api.root.children.slice(p.cursor,Math.min(total,p.cursor+p.limit)).map(n=>({id:n.id,name:n.name.slice(0,512)}));
      return result({action:p.action,pages,nextCursor:p.cursor+pages.length<total?p.cursor+pages.length:null,truncated:api.root.children.length>10000,scanned:total});
    }
    if(p.action==='components_list'){
      const components:NonNullable<DesignOutput['components']>=[];let scanned=0,matched=0,nextCursor:number|null=null,truncated=false;
      const stack:BaseNode[]=[page];
      while(stack.length){
        if(scanned>=10000){truncated=true;break;}const node=stack.pop()!;scanned++;
        if(managed(node))continue;
        if(node.type==='COMPONENT'){
          if(matched++>=p.cursor){if(components.length===p.limit){nextCursor=p.cursor+components.length;break;}
            components.push({id:node.id,name:node.name.slice(0,512),remote:node.remote,parentId:node.parent!.id,width:node.width,height:node.height});}
        }
        if('children'in node){const count=Math.min(node.children.length,Math.max(0,10000-scanned-stack.length));if(count<node.children.length)truncated=true;for(let i=count-1;i>=0;i--)stack.push(node.children[i]);}
      }
      return result({action:p.action,components,nextCursor,truncated,scanned});
    }
    if(!['component_create','instance_create','page_create','page_switch'].includes(p.action))return fail('UNSUPPORTED_COMPONENTS_PAGES_ACTION');
    const check=()=>{if(!canWrite())fail('WRITE_DISABLED');if(api.currentPage.id!==page.id||!('expectedPageId'in p)||p.expectedPageId!==page.id)fail('PAGE_CHANGED');};
    check();
    const finish=(design:DesignOutput,node?:BaseNode)=>{const r=result(design);r.completed=[0];if(node)r.created=[{index:0,id:node.id,type:node.type}];return r;};
    const failed=(e:unknown):Evidence=>({...result({action:p.action}),complete:false,failed:{index:0,code:'DESIGN_FAILED',message:(e instanceof Error?e.message:'DESIGN_FAILED').slice(0,512)}});
    if(p.action==='page_switch'){
      const node=await api.getNodeByIdAsync(p.pageId);check();if(!node||node.removed||node.type!=='PAGE'||node.parent?.id!==api.root.id)return fail('INVALID_PAGE');
      let unexpected=false,events=0;
      const changed=()=>{events++;if(api.currentPage.id!==node.id||events>1)unexpected=true;};
      api.on('currentpagechange',changed);
      try{
        check();await api.setCurrentPageAsync(node);
        if(!canWrite())fail('WRITE_DISABLED');if(unexpected||api.currentPage.id!==node.id)fail('PAGE_SWITCH_RACE');
        return finish({action:p.action,pageId:node.id,previousPageId:page.id});
      }catch(e){return failed(e);}finally{api.off('currentpagechange',changed);}
    }
    if(p.action==='page_create'){
      let node:PageNode|undefined;
      try{check();node=api.createPage();check();node.name=p.name;check();api.commitUndo();return finish({action:p.action,pageId:node.id},node);}
      catch(e){if(node&&!node.removed)node.remove();return failed(e);}
    }
    if(p.action!=='component_create'&&p.action!=='instance_create')return fail('UNSUPPORTED_COMPONENTS_PAGES_ACTION');
    const source=await api.getNodeByIdAsync(p.action==='component_create'?p.sourceId:p.componentId);check();
    const parentNode=p.parentId?await api.getNodeByIdAsync(p.parentId):page;check();const destination=parent(parentNode,page);
    const src=editable(source,page);
    if(p.action==='component_create'&&src.type!=='FRAME')return fail('INVALID_COMPONENT_SOURCE');
    if(p.action==='instance_create'&&(src.type!=='COMPONENT'||src.remote))return fail('LOCAL_COMPONENT_REQUIRED');
    boundedTree(src);
    let copy:SceneNode|undefined,node:ComponentNode|InstanceNode|undefined;
    try{
      check();parent(destination,page);editable(src,page);
      if(p.action==='component_create'){
        copy=(src as FrameNode).clone();check();node=api.createComponentFromNode(copy);check();
      }else{node=(src as ComponentNode).createInstance();check();}
      parent(destination,page);editable(src,page);destination.appendChild(node);
      if(p.name!==undefined)node.name=p.name;if(p.x!==undefined)node.x=p.x;if(p.y!==undefined)node.y=p.y;
      check();api.commitUndo();
      return finish(p.action==='component_create'?{action:p.action,componentId:node.id}:{action:p.action,componentId:src.id,instanceId:node.id},node);
    }catch(e){if(node&&!node.removed)node.remove();if(copy&&!copy.removed)copy.remove();return failed(e);}
  };
}
