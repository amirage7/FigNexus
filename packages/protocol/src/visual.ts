import {z} from 'zod';
import {Color,id} from './common';

const unit=z.number().finite().min(0).max(1);
const rgb=Color.omit({a:true});
const rgba=rgb.extend({a:unit}).strict();
const common={visible:z.boolean().optional(),opacity:unit.optional(),blendMode:z.enum(['NORMAL','DARKEN','MULTIPLY','LINEAR_BURN','COLOR_BURN','LIGHTEN','SCREEN','LINEAR_DODGE','COLOR_DODGE','OVERLAY','SOFT_LIGHT','HARD_LIGHT','DIFFERENCE','EXCLUSION','HUE','SATURATION','COLOR','LUMINOSITY']).optional()};
export const TransformSchema=z.tuple([z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]),z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])]).refine(t=>Number.isFinite(t[0][0]*t[1][1]-t[0][1]*t[1][0]) && t[0][0]*t[1][1]-t[0][1]*t[1][0]!==0,'Transform must be invertible');
const stops=z.array(z.object({position:unit,color:rgba}).strict()).min(2).max(16).refine(v=>v.every((stop,index)=>index===0||stop.position>=v[index-1].position),'Gradient stops must be sorted');
const solid=z.object({type:z.literal('SOLID'),color:rgb,...common}).strict();
const gradient=z.object({type:z.enum(['GRADIENT_LINEAR','GRADIENT_RADIAL','GRADIENT_ANGULAR','GRADIENT_DIAMOND']),gradientTransform:TransformSchema,gradientStops:stops,...common}).strict();
const filterValue=z.number().finite().min(-1).max(1).optional();
const filters=z.object({exposure:filterValue,contrast:filterValue,saturation:filterValue,temperature:filterValue,tint:filterValue,highlights:filterValue,shadows:filterValue}).strict();
const image=z.object({type:z.literal('IMAGE'),imageHash:id,scaleMode:z.enum(['FILL','FIT','CROP','TILE']),imageTransform:TransformSchema.optional(),scalingFactor:z.number().finite().positive().max(10000).optional(),rotation:z.number().finite().int().min(-360).max(360).multipleOf(90).optional(),filters:filters.optional(),...common}).strict().superRefine((v,c)=>{
 if(v.imageTransform!==undefined&&v.scaleMode!=='CROP')c.addIssue({code:'custom',message:'imageTransform requires CROP'});
 if(v.scalingFactor!==undefined&&v.scaleMode!=='TILE')c.addIssue({code:'custom',message:'scalingFactor requires TILE'});
 if(v.rotation!==undefined&&v.scaleMode==='CROP')c.addIssue({code:'custom',message:'rotation is unavailable for CROP'});
});
export const PaintSchema=z.union([solid,gradient,image]);
export const FillsSchema=z.array(PaintSchema).max(4);
export type PaintInput=z.infer<typeof PaintSchema>;
export const EffectSchema=z.object({type:z.enum(['DROP_SHADOW','INNER_SHADOW']),color:rgba,offset:z.object({x:z.number().finite().min(-10000).max(10000),y:z.number().finite().min(-10000).max(10000)}).strict(),radius:z.number().finite().min(0).max(1000),spread:z.number().finite().min(-1000).max(1000).optional(),visible:z.boolean().optional(),blendMode:common.blendMode,showShadowBehindNode:z.boolean().optional()}).strict().superRefine((v,c)=>{if(v.showShadowBehindNode!==undefined&&v.type!=='DROP_SHADOW')c.addIssue({code:'custom',message:'showShadowBehindNode requires DROP_SHADOW'});});
export const EffectsSchema=z.array(EffectSchema).max(4);
export type EffectInput=z.infer<typeof EffectSchema>;

export const ImageUploadInput=z.object({expectedPageId:id,uploadId:id,index:z.number().int().min(0).max(58),totalChunks:z.number().int().min(1).max(59),totalBytes:z.number().int().min(1).max(2097152),base64:z.string().min(4).max(48000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict().superRefine((v,c)=>{if(v.index>=v.totalChunks)c.addIssue({code:'custom',message:'Chunk index out of range'});if(v.totalBytes>v.totalChunks*36000)c.addIssue({code:'custom',message:'Too few chunks for image size'});});
export const ImageUploadState=z.object({uploadId:id,index:z.number().int().min(0).max(58),receivedBytes:z.number().int().min(0).max(2097152),complete:z.boolean(),imageHash:id.optional()}).strict().superRefine((v,c)=>{if(v.complete!==(v.imageHash!==undefined))c.addIssue({code:'custom',message:'Only complete uploads have an image hash'});});
export type ImageUploadState=z.infer<typeof ImageUploadState>;
