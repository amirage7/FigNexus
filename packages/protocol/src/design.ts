import {z} from 'zod';
import {id,Color,identity} from './common';
const scope={expectedPageId:id};
const page={cursor:z.number().int().min(0).max(10000).default(0),limit:z.number().int().min(1).max(50).default(20)};
const name=z.string().min(1).max(128),position={x:z.number().finite().min(-100000).max(100000).optional(),y:z.number().finite().min(-100000).max(100000).optional()};
export const VariableType=z.enum(['COLOR','FLOAT','STRING','BOOLEAN']);
export const VariableAlias=z.object({type:z.literal('VARIABLE_ALIAS'),id}).strict();
export const BoundVariablesSchema=z.record(z.union([VariableAlias,z.array(VariableAlias).max(4),z.record(VariableAlias).refine(v=>Object.keys(v).length<=20)])).refine(v=>Object.keys(v).length<=20);
export const VariableValue=z.union([Color,z.number().finite().min(-100000).max(100000),z.string().max(2048),z.boolean()]);
export const BindingField=z.enum(['fills','width','height','itemSpacing','paddingTop','paddingBottom','paddingLeft','paddingRight','cornerRadius','visible','characters']);
export const DesignParams=z.discriminatedUnion('action',[
  z.object({action:z.literal('components_list'),...page}).strict(),
  z.object({action:z.literal('component_create'),...scope,sourceId:id,parentId:id.optional(),name:name.optional(),...position}).strict(),
  z.object({action:z.literal('instance_create'),...scope,componentId:id,parentId:id,name:name.optional(),...position}).strict(),
  z.object({action:z.literal('variables_list'),...page}).strict(),
  z.object({action:z.literal('collection_create'),...scope,name}).strict(),
  z.object({action:z.literal('variable_create'),...scope,collectionId:id,name,resolvedType:VariableType,value:VariableValue}).strict(),
  z.object({action:z.literal('variable_set'),...scope,variableId:id,value:VariableValue}).strict(),
  z.object({action:z.literal('variable_bind'),...scope,variableId:id,nodeId:id,field:BindingField}).strict(),
  z.object({action:z.literal('variable_history'),variableId:id}).strict(),
  z.object({action:z.literal('variable_restore'),...scope,variableId:id,historyId:id}).strict(),
  z.object({action:z.literal('pages_list'),...page}).strict(),
  z.object({action:z.literal('page_create'),...scope,name}).strict(),
  z.object({action:z.literal('page_switch'),...scope,pageId:id}).strict()
]);
export type DesignParams=z.infer<typeof DesignParams>;
export const DesignOutput=z.object({
  action:z.string().min(1).max(64),componentId:id.optional(),instanceId:id.optional(),collectionId:id.optional(),variableId:id.optional(),boundVariableId:id.optional(),pageId:id.optional(),previousPageId:id.optional(),value:VariableValue.optional(),field:BindingField.optional(),
  components:z.array(z.object({id,name:z.string().max(512),remote:z.boolean(),parentId:id,width:z.number(),height:z.number()}).strict()).max(50).optional(),
  variables:z.array(z.object({id,name:z.string().max(512),collectionId:id,resolvedType:VariableType,value:VariableValue.optional(),managed:z.boolean()}).strict()).max(50).optional(),
  collections:z.array(z.object({id,name:z.string().max(512),defaultModeId:id,managed:z.boolean()}).strict()).max(50).optional(),
  pages:z.array(identity).max(50).optional(),
  historyChanged:z.boolean().optional(),
  history:z.array(z.object({id,createdAt:z.string().datetime(),value:VariableValue}).strict()).max(20).optional(),
  nextCursor:z.number().int().nullable().optional(),truncated:z.boolean().optional(),scanned:z.number().int().optional()
}).strict();
export type DesignOutput=z.infer<typeof DesignOutput>;
export const DESIGN_READ_ACTIONS=['components_list','variables_list','variable_history','pages_list'] as const;
export function isDesignWrite(params:DesignParams){return !(DESIGN_READ_ACTIONS as readonly string[]).includes(params.action);}
