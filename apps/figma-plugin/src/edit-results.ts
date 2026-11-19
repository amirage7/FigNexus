import type {z} from 'zod';
import {EditedNode,type ExecuteResult} from '@bridge/protocol';
import {serializePaints,serializeEffects} from './visual';
import {serializeVectorPaths} from './vector';

export type BatchResult=z.infer<typeof ExecuteResult>;
export function boundExecution(result:BatchResult):BatchResult{
 const over=()=>JSON.stringify(result).length*3>55000;
 // Preserve IDs, mappings, error evidence and per-item statuses. Only optional
 // visual/text readback is reduced, and every omitted field is identified.
 for(const field of ['fills','effects','strokes','vectorPaths','layout','characters','name'] as const){
  for(const item of result.results??[]){
   if(!over())return result;
   const node=item.node;if(!node||node[field]===undefined)continue;
   node.fieldsTruncated=[...(node.fieldsTruncated??[]),field];
   if(field==='fills'){delete node.fills;node.fillsTruncated=true;}
   else if(field==='characters'){node.characters=node.characters?.slice(0,64);node.charactersTruncated=true;}
   else if(field==='name')node.name=node.name.slice(0,64);
   else delete node[field];
  }
 }
 return result;
}
export function editSnapshot(node:BaseNode):z.infer<typeof EditedNode>{
 const result:z.infer<typeof EditedNode>={id:node.id,type:node.type,name:node.name,coordinateSpace:'parent',...(node.parent?{parentId:node.parent.id}:{})};
 if('x'in node){result.x=node.x;result.y=node.y;result.width=node.width;result.height=node.height;}
 if('opacity'in node)result.opacity=node.opacity;
 if('visible'in node)result.visible=node.visible;
 if('locked'in node)result.locked=node.locked;
 if('fills'in node){result.fills=serializePaints(node.fills);result.fillsTruncated=!Array.isArray(node.fills)||result.fills.length!==node.fills.length;}
 if('effects'in node)result.effects=serializeEffects(node.effects);
 if('strokes'in node)result.strokes=serializePaints(node.strokes);
 if('strokeWeight'in node&&typeof node.strokeWeight==='number')result.strokeWeight=node.strokeWeight;
 if(node.type==='LINE'||node.type==='VECTOR'){result.strokeCap=typeof node.strokeCap==='string'&&['NONE','ROUND','SQUARE'].includes(node.strokeCap)?node.strokeCap as 'NONE'|'ROUND'|'SQUARE':'MIXED';result.strokeJoin=typeof node.strokeJoin==='string'&&['MITER','ROUND','BEVEL'].includes(node.strokeJoin)?node.strokeJoin as 'MITER'|'ROUND'|'BEVEL':'MIXED';}
 if('rotation'in node)result.rotation=node.rotation;
 if('cornerRadius'in node)result.cornerRadius=typeof node.cornerRadius==='number'?node.cornerRadius:'MIXED';
 if(node.type==='VECTOR'){const paths=serializeVectorPaths(node.vectorPaths);result.vectorPaths=paths.vectorPaths;if(paths.vectorPathsTruncated)result.fieldsTruncated=[...(result.fieldsTruncated??[]),'vectorPaths'];}
 if(node.type==='FRAME')result.layout={direction:node.layoutMode,gap:node.itemSpacing,paddingTop:node.paddingTop,paddingBottom:node.paddingBottom,paddingLeft:node.paddingLeft,paddingRight:node.paddingRight,primaryAlign:node.primaryAxisAlignItems,counterAlign:node.counterAxisAlignItems,primarySizing:node.primaryAxisSizingMode,counterSizing:node.counterAxisSizingMode};
 if(result.layout)for(const key of Object.keys(result.layout))if(result.layout[key]===undefined)delete result.layout[key];
 if(node.type==='TEXT'){
  // Existing text may exceed the write limit. Readback is explicitly bounded.
  result.characters=node.characters.slice(0,2048);result.charactersTruncated=node.characters.length>2048;
  result.textAutoResize=node.textAutoResize;
  result.textAlignHorizontal=node.textAlignHorizontal;result.textAlignVertical=node.textAlignVertical;
  if(typeof node.fontSize==='number')result.fontSize=node.fontSize;
  if(typeof node.fontName==='object')result.font={family:node.fontName.family,style:node.fontName.style};
 }
 return result;
}
export function editError(error:unknown){
 const message=(error instanceof Error?error.message:'EDIT_FAILED').slice(0,512);
 const prefix=message.split(':')[0];
 return {code:/^[A-Z][A-Z_]+$/.test(prefix)?prefix:'EDIT_FAILED',message};
}
export function assertPrivateData(api:object,node?:Pick<BaseNode,'getPluginData'>){
 try{
  if('pluginId'in api&&(typeof api.pluginId!=='string'||!/^\d+$/.test(api.pluginId)))throw Error('Missing manifest ID');
  node?.getPluginData('ai-bridge-capability-probe');
 }catch{
  throw Error('PLUGIN_DATA_UNAVAILABLE: Private plugin data requires a valid local Figma manifest ID. Run pnpm plugin:id <Figma-assigned numeric plugin ID>, rebuild and reimport the plugin.');
 }
}
