import {VariableAlias,type BoundVariablesSchema} from '../../../packages/protocol/src/design';
import type {z} from 'zod';
export function serializeBindings(raw:unknown){
  const bindings:z.infer<typeof BoundVariablesSchema>=Object.create(null);let truncated=false;
  const acceptable=(key:string)=>key.length<=128;
  const alias=(value:unknown)=>{const p=VariableAlias.safeParse(value);return p.success?p.data:undefined;};
  if(!raw||typeof raw!=='object')return {bindings,truncated};
  const entries=Object.entries(raw);if(entries.length>20)truncated=true;
  for(const [key,value]of entries.slice(0,20)){
    if(!acceptable(key)){truncated=true;continue;}
    let selected:z.infer<typeof BoundVariablesSchema>[string]|undefined=alias(value);
    if(!selected&&Array.isArray(value)){
      if(value.length>4)truncated=true;
      const parsed=value.slice(0,4).map(alias).filter((v):v is z.infer<typeof VariableAlias>=>!!v);if(parsed.length!==Math.min(value.length,4))truncated=true;selected=parsed;
    }else if(!selected&&value&&typeof value==='object'){
      const nested:Record<string,z.infer<typeof VariableAlias>>=Object.create(null),pairs=Object.entries(value);if(pairs.length>20)truncated=true;
      for(const [name,v]of pairs.slice(0,20)){const a=alias(v);if(a&&acceptable(name))nested[name]=a;else truncated=true;}
      selected=nested;
    }
    if(selected===undefined){truncated=true;continue;}
    bindings[key]=selected;
    if(JSON.stringify(bindings).length>2048){delete bindings[key];truncated=true;}
  }
  return {bindings,truncated};
}
