import {ImageUploadInput,type ImageUploadState} from '../../../packages/protocol/src/visual';
import type {FileContext} from '../../../packages/protocol/src/common';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function decodeBase64(value:string):Uint8Array{
 if(!value.length||value.length>48000||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('INVALID_BASE64');
 const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
 if(padding===2&&(alphabet.indexOf(value[value.length-3])&15)!==0||padding===1&&(alphabet.indexOf(value[value.length-2])&3)!==0)throw new Error('INVALID_BASE64');
 const bytes=new Uint8Array(value.length/4*3-padding);let at=0;
 for(let i=0;i<value.length;i+=4){const a=alphabet.indexOf(value[i]),b=alphabet.indexOf(value[i+1]),c=value[i+2]==='='?0:alphabet.indexOf(value[i+2]),d=value[i+3]==='='?0:alphabet.indexOf(value[i+3]);bytes[at++]=(a<<2)|(b>>4);if(at<bytes.length)bytes[at++]=((b&15)<<4)|(c>>2);if(at<bytes.length)bytes[at++]=((c&3)<<6)|d;}
 return bytes;
}
function u32(bytes:Uint8Array,at:number){return bytes[at]*16777216+bytes[at+1]*65536+bytes[at+2]*256+bytes[at+3];}
function validDimensions(width:number,height:number){return width>0&&height>0&&width<=16384&&height<=16384;}
function validateImage(bytes:Uint8Array){
 const png=[137,80,78,71,13,10,26,10];
 if(bytes.length>=45&&png.every((byte,i)=>bytes[i]===byte)){
  let at=8,first=true,hasData=false;
  while(at+12<=bytes.length){
   const size=u32(bytes,at);if(size>bytes.length-at-12)break;
   const kind=String.fromCharCode(...bytes.subarray(at+4,at+8));
   if(first){if(kind!=='IHDR'||size!==13||!validDimensions(u32(bytes,at+8),u32(bytes,at+12)))break;first=false;}
   else if(kind==='IHDR')break;
   if(kind==='IDAT'&&size>0)hasData=true;
   at+=size+12;
   if(kind==='IEND'){if(size===0&&hasData&&at===bytes.length)return;break;}
  }
 }else if(bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217){
  let at=2,dimensions=false;
  while(at<bytes.length-2){
   if(bytes[at++]!==255)break;while(bytes[at]===255)at++;
   const marker=bytes[at++];if(marker===0||marker===216||marker===217)break;
   if(marker===1||marker>=208&&marker<=215)continue;
   if(at+2>bytes.length)break;const size=bytes[at]*256+bytes[at+1];if(size<2||at+size>bytes.length)break;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(size<8||!validDimensions(bytes[at+5]*256+bytes[at+6],bytes[at+3]*256+bytes[at+4]))break;dimensions=true;}
   if(marker===218){if(dimensions&&at+size<bytes.length-2)return;break;}
   at+=size;
  }
 }
 throw new Error('UNSUPPORTED_IMAGE');
}
type Upload={pageId:string;instanceId:string;documentId:string;createdAt:number;totalBytes:number;totalChunks:number;receivedBytes:number;chunks:Uint8Array[];encoded:string[];imageHash?:string};
export class NativeImageUploads{
 private readonly uploads=new Map<string,Upload>();
 constructor(private readonly api:Pick<PluginAPI,'currentPage'|'createImage'>,private readonly canWrite:()=>boolean,private readonly context:()=>FileContext){}
 async handle(raw:unknown):Promise<ImageUploadState>{
  const input=ImageUploadInput.parse(raw),initial=this.context();
  const check=()=>{if(!this.canWrite())throw new Error('WRITE_DISABLED');const current=this.context();if(this.api.currentPage.id!==input.expectedPageId||current.page.id!==input.expectedPageId)throw new Error('PAGE_CHANGED');if(current.instanceId!==initial.instanceId||current.document.id!==initial.document.id)throw new Error('CONTEXT_CHANGED');};
  check();const bytes=decodeBase64(input.base64);
  // Keep this boundary explicit: permission/context can change while queued requests yield.
  await Promise.resolve();check();
  const now=Date.now();for(const [key,value] of this.uploads)if(now-value.createdAt>=120000)this.uploads.delete(key);
  let upload=this.uploads.get(input.uploadId);
  if(upload){
   if(upload.pageId!==input.expectedPageId||upload.instanceId!==initial.instanceId||upload.documentId!==initial.document.id)throw new Error('CONTEXT_CHANGED');
   if(upload.totalBytes!==input.totalBytes||upload.totalChunks!==input.totalChunks)throw new Error('UPLOAD_METADATA_CHANGED');
   if(input.index<upload.chunks.length){if(upload.encoded[input.index]!==input.base64)throw new Error('UPLOAD_CHUNK_CHANGED');return this.state(input.uploadId,input.index,upload);}
  }else{
   if(input.index!==0)throw new Error('UPLOAD_OUT_OF_ORDER');
   if(this.uploads.size>=2)throw new Error('UPLOAD_LIMIT');
   upload={pageId:input.expectedPageId,instanceId:initial.instanceId,documentId:initial.document.id,createdAt:now,totalBytes:input.totalBytes,totalChunks:input.totalChunks,receivedBytes:0,chunks:[],encoded:[]};
   this.uploads.set(input.uploadId,upload);
  }
  if(input.index!==upload.chunks.length)throw new Error('UPLOAD_OUT_OF_ORDER');
  if(upload.receivedBytes+bytes.length>upload.totalBytes)throw new Error('UPLOAD_SIZE_MISMATCH');
  const received=upload.receivedBytes+bytes.length;
  const complete=input.index===upload.totalChunks-1;
  if(complete&&received!==upload.totalBytes||!complete&&received>=upload.totalBytes)throw new Error('UPLOAD_SIZE_MISMATCH');
  if(complete){
   const image=new Uint8Array(received);let offset=0;for(const chunk of [...upload.chunks,bytes]){image.set(chunk,offset);offset+=chunk.length;}
   validateImage(image);check();const native=this.api.createImage(image);
   if(!native?.hash)throw new Error('IMAGE_CREATE_FAILED');upload.imageHash=native.hash;
  }
  upload.chunks.push(bytes);upload.encoded.push(input.base64);upload.receivedBytes=received;
  return this.state(input.uploadId,input.index,upload);
 }
 private state(uploadId:string,index:number,upload:Upload):ImageUploadState{return {uploadId,index,receivedBytes:upload.receivedBytes,complete:upload.imageHash!==undefined,...(upload.imageHash?{imageHash:upload.imageHash}:{})};}
}
