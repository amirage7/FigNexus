import {expect,it,vi} from 'vitest';
import {PaintSchema,FillsSchema,EffectsSchema} from '../packages/protocol/src/visual';
import {toNativePaints,toNativeEffects,serializePaints,serializeEffects} from '../apps/figma-plugin/src/visual';
const gradient={type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:.5}}]} as const;
it.each(['GRADIENT_LINEAR','GRADIENT_RADIAL','GRADIENT_ANGULAR','GRADIENT_DIAMOND'])('creates a native %s paint with exact stop alpha',type=>{
 const input={...gradient,type}; const paints=toNativePaints({getImageByHash:vi.fn()} as any,[input]);
 expect(paints).toEqual([input]);expect(serializePaints(paints)).toEqual([input]);
});
it('validates bounded sorted stops and invertible finite matrices',()=>{
 for(const patch of [{gradientStops:[]},{gradientStops:[gradient.gradientStops[1],gradient.gradientStops[0]]},{gradientTransform:[[1,2,0],[2,4,0]]},{gradientTransform:[[Infinity,0,0],[0,1,0]]},{gradientTransform:[[1,0],[0,1]]},{gradientStops:Array(17).fill(gradient.gradientStops[0])},{gradientStops:[{position:0,color:{r:1,g:0,b:0}},gradient.gradientStops[1]]}]) expect(PaintSchema.safeParse({...gradient,...patch}).success).toBe(false);
 expect(FillsSchema.safeParse(Array(5).fill(gradient)).success).toBe(false);
});
it('rejects unknown images before returning any mutation-ready paints',()=>{
 const api={getImageByHash:vi.fn(()=>null)};
 expect(()=>toNativePaints(api as any,[{type:'SOLID',color:{r:1,g:0,b:0}},{type:'IMAGE',imageHash:'unknown',scaleMode:'FILL'}])).toThrow('UNKNOWN_IMAGE_HASH');
 expect(PaintSchema.safeParse({type:'IMAGE',imageHash:null,scaleMode:'FILL'}).success).toBe(false);
 expect(PaintSchema.safeParse({type:'IMAGE',imageHash:'hash',scaleMode:'FIT',imageTransform:[[1,0,0],[0,1,0]]}).success).toBe(false);
 expect(PaintSchema.safeParse({type:'IMAGE',imageHash:'hash',scaleMode:'FILL',scalingFactor:2}).success).toBe(false);
 expect(PaintSchema.safeParse({type:'IMAGE',imageHash:'hash',scaleMode:'CROP',rotation:90}).success).toBe(false);
 expect(PaintSchema.safeParse({type:'IMAGE',imageHash:'hash',scaleMode:'TILE',scalingFactor:0}).success).toBe(false);
 expect(PaintSchema.safeParse({type:'IMAGE',imageHash:'hash',scaleMode:'FIT',rotation:45}).success).toBe(false);
});
it('supports crop and tile transforms and bounds readback without arbitrary fields',()=>{
 const paints=toNativePaints({getImageByHash:()=>({})} as any,[{type:'IMAGE',imageHash:'hash',scaleMode:'CROP',imageTransform:[[1,0,.2],[0,1,.4]]},{type:'IMAGE',imageHash:'hash',scaleMode:'TILE',scalingFactor:2,rotation:90}]);
 expect(serializePaints(paints)).toEqual(paints);
 expect(serializePaints([{type:'SOLID',color:{r:.1,g:.2,b:.3},opacity:.4,boundVariables:{color:{type:'VARIABLE_ALIAS',id:'x'}},code:'bad'},...Array(8).fill(gradient)] as any)).toHaveLength(4);
 expect(serializePaints([{type:'IMAGE',imageHash:null,scaleMode:'FILL'},{type:'VIDEO'}] as any)).toEqual([]);
});
it('creates actual native drop and inner shadow effects',()=>{
 const effects=[{type:'DROP_SHADOW',color:{r:0,g:0,b:0,a:.2},offset:{x:0,y:8},radius:12,spread:2,visible:true,blendMode:'NORMAL'},{type:'INNER_SHADOW',color:{r:0,g:0,b:1,a:.4},offset:{x:-2,y:1},radius:4,visible:true,blendMode:'NORMAL'}];
 expect(toNativeEffects(effects)).toEqual(effects);expect(serializeEffects(effects as any)).toEqual(effects);
 expect(EffectsSchema.safeParse(Array(5).fill(effects[0])).success).toBe(false);
 expect(EffectsSchema.safeParse([{...effects[0],radius:-1}]).success).toBe(false);
 expect(EffectsSchema.safeParse([{...effects[0],color:{r:0,g:0,b:0,a:2}}]).success).toBe(false);
});
