import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageFileImporter} from '../packages/mcp-server/src/image-import';
import {ImageUploadInput,Result} from '../packages/protocol/src';
import type {z} from 'zod';

type Chunk=z.infer<typeof ImageUploadInput>;
type Success=Extract<Result,{ok:true}>;
const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function file(size=72005,jpeg=false){
 const directory=await mkdtemp(join(tmpdir(),'image-import-'));directories.push(directory);
 const bytes=Buffer.alloc(size,19);(jpeg?Buffer.from([255,216,255]):Buffer.from([137,80,78,71,13,10,26,10])).copy(bytes);
 const path=join(directory,'source.png');await writeFile(path,bytes);return {path,bytes};
}
function input(path:string){return {path,requestId:'import-one',instanceId:'runtime-one',expectedPageId:'page-one'};}
function success(requestId:string,chunk:Chunk,instanceId='runtime-one'):Success {
 return {type:'result',ok:true,requestId,data:{context:{instanceId,document:{id:'doc',name:'Doc'},page:{id:'page-one',name:'Page'}},complete:true,created:[],refs:{},skipped:[],image:{uploadId:chunk.uploadId,index:chunk.index,receivedBytes:Math.min((chunk.index+1)*36000,chunk.totalBytes),complete:chunk.index===chunk.totalChunks-1,...(chunk.index===chunk.totalChunks-1?{imageHash:'native-hash'}:{})}}};
}
it('sends bounded ordered chunks that reconstruct the exact file and returns the final hash',async()=>{
 const source=await file();const chunks:Chunk[]=[];const ids:string[]=[];
 const result=await new ImageFileImporter().import(input(source.path),async(id,chunk)=>{ImageUploadInput.parse(chunk);chunks.push(chunk);ids.push(id);return success(id,chunk);});
 expect(chunks.map(c=>c.index)).toEqual([0,1,2]);expect(chunks.map(c=>c.base64.length)).toEqual([48000,48000,8]);
 expect(Buffer.concat(chunks.map(c=>Buffer.from(c.base64,'base64')))).toEqual(source.bytes);
 expect(new Set(chunks.map(c=>c.uploadId)).size).toBe(1);expect(ids.every(id=>id.length<=128)).toBe(true);
 expect('image' in result.data&&result.data.image.imageHash).toBe('native-hash');
});
it('accepts local JPEG signatures',async()=>{const source=await file(15,true);await new ImageFileImporter().import(input(source.path),async(id,c)=>success(id,c));});
it.each(['relative.png','https://example.com/secret.png','file:///C:/secret.png','\\\\server\\share\\secret.png','//server/share/secret.png'])('rejects nonlocal or relative paths %s',async path=>{
 const dispatch=vi.fn();await expect(new ImageFileImporter().import(input(path),dispatch)).rejects.toThrow('INVALID_IMAGE_PATH');expect(dispatch).not.toHaveBeenCalled();
});
it('rejects invalid signatures, oversized files, directories, and missing files without exposing paths or bytes',async()=>{
 const source=await file();const dispatch=vi.fn();const importer=new ImageFileImporter();
 await writeFile(source.path,'secret body');await expect(importer.import(input(source.path),dispatch)).rejects.toThrow('INVALID_IMAGE_FORMAT');
 await writeFile(source.path,Buffer.alloc(2097153));await expect(importer.import(input(source.path),dispatch)).rejects.toThrow('IMAGE_TOO_LARGE');
 await expect(importer.import(input(directories[0]),dispatch)).rejects.toThrow('INVALID_IMAGE_FILE');
 await expect(importer.import(input(join(directories[0],'secret-token')),dispatch)).rejects.toThrow(/^IMAGE_READ_FAILED$/);expect(dispatch).not.toHaveBeenCalled();
});
it('reuses exact write IDs on retry and rejects changed bytes, paths, page, or runtime before dispatch',async()=>{
 const source=await file(20);const importer=new ImageFileImporter();const dispatch=vi.fn(async(id:string,c:Chunk)=>success(id,c));
 await importer.import(input(source.path),dispatch);await importer.import(input(source.path),dispatch);
 expect(dispatch.mock.calls[0]).toEqual(dispatch.mock.calls[1]);dispatch.mockClear();
 await expect(importer.import({...input(source.path),instanceId:'restarted'},dispatch)).rejects.toThrow('IMAGE_IMPORT_CONFLICT');
 await expect(importer.import({...input(source.path),expectedPageId:'another-page'},dispatch)).rejects.toThrow('IMAGE_IMPORT_CONFLICT');
 const other=await file(20);await expect(importer.import(input(other.path),dispatch)).rejects.toThrow('IMAGE_IMPORT_CONFLICT');
 source.bytes[10]=22;await writeFile(source.path,source.bytes);await expect(importer.import(input(source.path),dispatch)).rejects.toThrow('IMAGE_IMPORT_CONFLICT');expect(dispatch).not.toHaveBeenCalled();
});
it('stops after a failed chunk without retrying and retains identity for later explicit retry',async()=>{
 const source=await file();const importer=new ImageFileImporter();const ids:string[]=[];
 await expect(importer.import(input(source.path),async(id,c)=>{ids.push(id);if(c.index===1)throw new Error('private body');return success(id,c);})).rejects.toThrow(/^IMAGE_CHUNK_FAILED$/);
 expect(ids).toHaveLength(2);const retried:string[]=[];await importer.import(input(source.path),async(id,c)=>{retried.push(id);return success(id,c);});expect(retried.slice(0,2)).toEqual(ids);
});
it.each(['runtime','page','upload','index','bytes','execution','completion','request'])('stops on invalid %s acknowledgements',async kind=>{
 const source=await file();const dispatch=vi.fn(async(id:string,c:Chunk)=>{
  const result=success(id,c);if(!('image' in result.data))throw new Error('fixture');
  if(kind==='runtime')result.data.context.instanceId='restart';if(kind==='page')result.data.context.page.id='other';
  if(kind==='upload')result.data.image.uploadId='other';if(kind==='index')result.data.image.index=9;
  if(kind==='bytes')result.data.image.receivedBytes=1;if(kind==='execution')result.data.complete=false;
  if(kind==='completion'){result.data.image.complete=true;result.data.image.imageHash='early';}if(kind==='request')result.requestId='other';return result;
 });await expect(new ImageFileImporter().import(input(source.path),dispatch)).rejects.toThrow('IMAGE_CHUNK_INVALID');expect(dispatch).toHaveBeenCalledTimes(1);
});
it('bounds retained request guards without evicting uncertain imports',async()=>{
 const source=await file(20);const importer=new ImageFileImporter();const dispatch=vi.fn(async(id:string,c:Chunk)=>success(id,c));
 for(let index=0;index<256;index++)await importer.import({...input(source.path),requestId:`r-${index}`},dispatch);
 dispatch.mockClear();await expect(importer.import({...input(source.path),requestId:'overflow'},dispatch)).rejects.toThrow('IMAGE_IMPORT_CAPACITY');expect(dispatch).not.toHaveBeenCalled();
});
it('accepts exactly 2 MiB and keeps alias uploads tied to the original write IDs',async()=>{
 const source=await file(2097152);const importer=new ImageFileImporter();const ids:string[]=[];
 await importer.import({...input(source.path),requestId:'r'.repeat(110)},async(id,c)=>{ids.push(id);expect(id.length).toBeLessThanOrEqual(128);expect(c.uploadId.length).toBeLessThanOrEqual(128);return success(id,c);});
 expect(ids).toHaveLength(59);const alias:string[]=[];
 await importer.import({...input(source.path),requestId:'alias'},async(id,c)=>{alias.push(id);return success(id,c);});expect(alias).toEqual(ids);
});
it('rejects concurrent reuse of a request for different source files before a second dispatch',async()=>{
 const first=await file(20);const second=await file(21);const importer=new ImageFileImporter();const dispatch=vi.fn(async(id:string,c:Chunk)=>success(id,c));
 const results=await Promise.allSettled([importer.import(input(first.path),dispatch),importer.import(input(second.path),dispatch)]);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(dispatch).toHaveBeenCalledTimes(1);
});
