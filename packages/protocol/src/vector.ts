import {z} from 'zod';
export const MAX_VECTOR_PATHS=16;
export const MAX_VECTOR_COMMANDS=256;
export const MAX_TOTAL_VECTOR_COMMANDS=1024;
// Leave room for geometry and paint fields inside the bounded read response.
export const MAX_NATIVE_VECTOR_DATA=8192;

const coordinate=z.number().finite().min(-10000).max(10000);
const command=z.discriminatedUnion('op',[
 z.object({op:z.literal('M'),x:coordinate,y:coordinate}).strict(),
 z.object({op:z.literal('L'),x:coordinate,y:coordinate}).strict(),
 z.object({op:z.literal('C'),x1:coordinate,y1:coordinate,x2:coordinate,y2:coordinate,x:coordinate,y:coordinate}).strict(),
 z.object({op:z.literal('Q'),x1:coordinate,y1:coordinate,x:coordinate,y:coordinate}).strict(),
 z.object({op:z.literal('Z')}).strict()
]);
const inputPath=z.object({windingRule:z.enum(['NONZERO','EVENODD']),commands:z.array(command).min(2).max(MAX_VECTOR_COMMANDS)}).strict().superRefine((path,ctx)=>{
 let open=false,drawn=false;
 for(let i=0;i<path.commands.length;i++){
  const cmd=path.commands[i];
  if(cmd.op==='M'){
   if(open&&!drawn)ctx.addIssue({code:'custom',path:['commands',i],message:'Every subpath must contain a drawing command'});
   open=true;drawn=false;
  }else if(cmd.op==='Z'){
   if(!open||!drawn)ctx.addIssue({code:'custom',path:['commands',i],message:'Close requires an open drawable subpath'});
   open=false;
  }else{
   if(!open)ctx.addIssue({code:'custom',path:['commands',i],message:'Drawing requires an initial move or a new move after closing'});
   drawn=true;
  }
 }
 if(open&&!drawn)ctx.addIssue({code:'custom',path:['commands'],message:'Every subpath must contain a drawing command'});
});
export const VectorPathsInputSchema=z.array(inputPath).min(1).max(MAX_VECTOR_PATHS).superRefine((paths,ctx)=>{
 let count=0;for(const path of paths)count+=path.commands.length;
 if(count>MAX_TOTAL_VECTOR_COMMANDS)ctx.addIssue({code:'custom',message:'Vector paths exceed the total command limit'});
});
export type VectorPathsInput=z.infer<typeof VectorPathsInputSchema>;
// Native data is an output-only representation. Do not use this schema for writes.
export const NativeVectorPathSchema=z.object({windingRule:z.enum(['NONZERO','EVENODD','NONE']),data:z.string().max(MAX_NATIVE_VECTOR_DATA)}).strict();
export const NativeVectorPathsSchema=z.array(NativeVectorPathSchema).max(MAX_VECTOR_PATHS).superRefine((paths,ctx)=>{
 let count=0;for(const path of paths)count+=path.data.length;
 if(count>MAX_NATIVE_VECTOR_DATA)ctx.addIssue({code:'custom',message:'Native vector paths exceed the total data limit'});
});
export type NativeVectorPaths=z.infer<typeof NativeVectorPathsSchema>;
export const StrokeCapSchema=z.enum(['NONE','ROUND','SQUARE']);
export const StrokeJoinSchema=z.enum(['MITER','ROUND','BEVEL']);
