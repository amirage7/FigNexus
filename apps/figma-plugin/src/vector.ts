import {VectorPathsInputSchema,NativeVectorPathSchema,MAX_VECTOR_PATHS,MAX_NATIVE_VECTOR_DATA,type NativeVectorPaths} from '../../../packages/protocol/src/vector';

// Complete validation precedes serialization and any caller's native mutation.
export function toNativeVectorPaths(raw:unknown):VectorPath[]{
 return VectorPathsInputSchema.parse(raw).map(path=>({
  windingRule:path.windingRule,
  data:path.commands.map(command=>{
   switch(command.op){
    case 'M':case 'L':return `${command.op} ${command.x} ${command.y}`;
    case 'Q':return `Q ${command.x1} ${command.y1} ${command.x} ${command.y}`;
    case 'C':return `C ${command.x1} ${command.y1} ${command.x2} ${command.y2} ${command.x} ${command.y}`;
    case 'Z':return 'Z';
   }
  }).join(' ')
 }));
}

export function serializeVectorPaths(native:VectorPaths):{vectorPaths:NativeVectorPaths;vectorPathsTruncated:boolean}{
 const vectorPaths:NativeVectorPaths=[];
 let vectorPathsTruncated=native.length>MAX_VECTOR_PATHS,total=0;
 for(const path of native.slice(0,MAX_VECTOR_PATHS)){
  const parsed=NativeVectorPathSchema.safeParse({windingRule:path.windingRule,data:path.data});
  if(!parsed.success||total+parsed.data.data.length>MAX_NATIVE_VECTOR_DATA){vectorPathsTruncated=true;continue;}
  total+=parsed.data.data.length;
  vectorPaths.push(parsed.data);
 }
 return {vectorPaths,vectorPathsTruncated};
}
