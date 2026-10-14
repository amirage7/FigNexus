import {PaintSchema,FillsSchema,EffectsSchema,EffectSchema,type PaintInput,type EffectInput} from '../../../packages/protocol/src/visual';

// Always finish validating every paint before callers mutate a Figma node.
export function toNativePaints(api:Pick<PluginAPI,'getImageByHash'>,raw:unknown):Paint[]{
 const inputs=FillsSchema.parse(raw);
 for(const paint of inputs)if(paint.type==='IMAGE'&&!api.getImageByHash(paint.imageHash))throw new Error('UNKNOWN_IMAGE_HASH');
 return inputs.map(p=>JSON.parse(JSON.stringify(p)) as Paint);
}
export function toNativeEffects(raw:unknown):Effect[]{
 return EffectsSchema.parse(raw).map(effect=>({...effect,visible:effect.visible??true,blendMode:effect.blendMode??'NORMAL'})) as Effect[];
}
const paintCommon=['visible','opacity','blendMode'] as const;
function copy(source:object,keys:readonly string[]):Record<string,unknown>{const result:Record<string,unknown>={};for(const key of keys)if(key in source&&(source as Record<string,unknown>)[key]!==undefined)result[key]=(source as Record<string,unknown>)[key];return result;}
export function serializePaints(paints:readonly Paint[]|symbol):PaintInput[]{
 if(!Array.isArray(paints))return [];
 const result:PaintInput[]=[];
 for(const paint of paints.slice(0,4)){
  let data:Record<string,unknown>={type:paint.type,...copy(paint,paintCommon)};
  if(paint.type==='SOLID')data.color=copy(paint.color,['r','g','b']);
  else if(paint.type.startsWith('GRADIENT_')){
   const g=paint as GradientPaint;if(g.gradientStops.length>16)continue;
   data.gradientTransform=g.gradientTransform;data.gradientStops=g.gradientStops.map(s=>({position:s.position,color:copy(s.color,['r','g','b','a'])}));
  }else if(paint.type==='IMAGE'){
   data={...data,...copy(paint,['imageHash','scaleMode'])};
   if(paint.scaleMode==='CROP')Object.assign(data,copy(paint,['imageTransform']));
   if(paint.scaleMode==='TILE')Object.assign(data,copy(paint,['scalingFactor']));
   if(paint.scaleMode!=='CROP')Object.assign(data,copy(paint,['rotation']));
   if(paint.filters)data.filters=copy(paint.filters,['exposure','contrast','saturation','temperature','tint','highlights','shadows']);
  }else continue;
  const parsed=PaintSchema.safeParse(data);if(parsed.success)result.push(parsed.data);
 }
 return result;
}
export function serializeEffects(effects:readonly Effect[]):EffectInput[]{
 const result:EffectInput[]=[];
 for(const effect of effects.slice(0,4)){
  if(effect.type!=='DROP_SHADOW'&&effect.type!=='INNER_SHADOW')continue;
  const data={...copy(effect,['type','radius','spread','visible','blendMode',...(effect.type==='DROP_SHADOW'?['showShadowBehindNode']:[])]),color:copy(effect.color,['r','g','b','a']),offset:copy(effect.offset,['x','y'])};
  const parsed=EffectSchema.safeParse(data);if(parsed.success)result.push(parsed.data);
 }
 return result;
}
