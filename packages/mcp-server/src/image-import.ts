import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {ImageUploadInput,ImageUploadResult,Result} from '../../protocol/src';

const MAX_BYTES=2097152;
const CHUNK_BYTES=36000;
const MAX_IMPORTS=256;
type Success=Extract<Result,{ok:true}>;
type Input={path:string;requestId:string;instanceId:string;expectedPageId:string};
type Guard={path:string;digest:string;instanceId:string;expectedPageId:string};
type Upload={baseId:string;uploadId:string};

function localAbsolutePath(path:string){
 return typeof path==='string'&&path.length>0&&!path.includes('\0')&&!/^(?:[a-z][a-z0-9+.-]*:\/\/|\\\\|\/\/)/i.test(path)&&isAbsolute(path)&&
  (process.platform!=='win32'||/^[a-z]:[\\/]/i.test(path));
}

async function readImage(path:string):Promise<Buffer>{
 if(!localAbsolutePath(path))throw new Error('INVALID_IMAGE_PATH');
 let handle:Awaited<ReturnType<typeof open>>;
 try{handle=await open(path,'r');}catch{throw new Error('IMAGE_READ_FAILED');}
 let bytes:Buffer;
 try{
  const stat=await handle.stat();
  if(!stat.isFile())throw new Error('INVALID_IMAGE_FILE');
  if(stat.size>MAX_BYTES)throw new Error('IMAGE_TOO_LARGE');
  // Always cap reads independently of stat: a file can grow after its metadata is checked.
  const bounded=Buffer.alloc(MAX_BYTES+1);let length=0;
  while(length<bounded.length){
   const {bytesRead}=await handle.read(bounded,length,bounded.length-length,length);
   if(bytesRead===0)break;length+=bytesRead;
  }
  if(length>MAX_BYTES)throw new Error('IMAGE_TOO_LARGE');
  bytes=bounded.subarray(0,length);
 }catch(error){
  if(error instanceof Error&&['INVALID_IMAGE_FILE','IMAGE_TOO_LARGE'].includes(error.message))throw error;
  throw new Error('IMAGE_READ_FAILED');
 }finally{try{await handle.close();}catch{/* Never expose filesystem errors or file content. */}}
 const png=bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(!png&&!jpeg)throw new Error('INVALID_IMAGE_FORMAT');
 return bytes;
}

/** Keeps write identities for the lifetime of this MCP process, including uncertain failures. */
export class ImageFileImporter{
 private readonly requests=new Map<string,Guard>();
 private readonly uploads=new Map<string,Upload>();

 async import(input:Input,dispatch:(requestId:string,params:z.infer<typeof ImageUploadInput>)=>Promise<Success>):Promise<Success>{
  if(!input.requestId||input.requestId.length>110||!input.instanceId||input.instanceId.length>128||!input.expectedPageId||input.expectedPageId.length>128)throw new Error('INVALID_IMAGE_IMPORT');
  const previous=this.requests.get(input.requestId);
  if(previous&&(previous.path!==input.path||previous.instanceId!==input.instanceId||previous.expectedPageId!==input.expectedPageId))throw new Error('IMAGE_IMPORT_CONFLICT');
  if(!previous&&this.requests.size>=MAX_IMPORTS)throw new Error('IMAGE_IMPORT_CAPACITY');
  const bytes=await readImage(input.path);
  const digest=createHash('sha256').update(bytes).digest('hex');
  // Another call may claim this request while the bounded file read is in flight.
  const current=this.requests.get(input.requestId);
  if(current&&(current.path!==input.path||current.instanceId!==input.instanceId||current.expectedPageId!==input.expectedPageId||current.digest!==digest))throw new Error('IMAGE_IMPORT_CONFLICT');
  if(!current&&this.requests.size>=MAX_IMPORTS)throw new Error('IMAGE_IMPORT_CAPACITY');
  this.requests.set(input.requestId,{path:input.path,digest,instanceId:input.instanceId,expectedPageId:input.expectedPageId});
  const key=JSON.stringify([input.instanceId,input.expectedPageId,digest]);
  let upload=this.uploads.get(key);
  if(!upload){
   upload={baseId:input.requestId,uploadId:`image:${digest}:${createHash('sha256').update(input.requestId).digest('hex').slice(0,32)}`};
   this.uploads.set(key,upload);
  }
  const totalChunks=Math.ceil(bytes.length/CHUNK_BYTES);
  let lastResult:Success|undefined;
  for(let index=0;index<totalChunks;index++){
   const requestId=`${upload.baseId}:chunk:${index}`;
   const params=ImageUploadInput.parse({expectedPageId:input.expectedPageId,uploadId:upload.uploadId,index,totalChunks,totalBytes:bytes.length,base64:bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES).toString('base64')});
   let result:Success;
   try{result=await dispatch(requestId,params);}catch{throw new Error('IMAGE_CHUNK_FAILED');}
   const validated=Result.safeParse(result);
   if(!validated.success||!validated.data.ok||validated.data.requestId!==requestId)throw new Error('IMAGE_CHUNK_INVALID');
   const parsed=ImageUploadResult.safeParse(validated.data.data);
   if(!parsed.success)throw new Error('IMAGE_CHUNK_INVALID');
   const data=parsed.data;
   if(data.context.instanceId!==input.instanceId||data.context.page.id!==input.expectedPageId||data.complete!==true||data.failed!==undefined||
    data.image.uploadId!==upload.uploadId||data.image.index!==index||data.image.receivedBytes!==Math.min((index+1)*CHUNK_BYTES,bytes.length)||data.image.complete!==(index===totalChunks-1))throw new Error('IMAGE_CHUNK_INVALID');
   lastResult=validated.data;
  }
  return lastResult!;
 }
}
