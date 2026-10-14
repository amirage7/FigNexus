import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
export function validatePng(bytes: Buffer) {
  if (bytes.length < 24 || bytes.length > 2097152 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12,16).toString('ascii') !== 'IHDR') throw new Error('INVALID_PNG');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if (!width || !height || Math.max(width,height)>2048) throw new Error('INVALID_PNG_SIZE');
  return {width,height};
}
export class PreviewStore {
  private files=new Map<string,string>();
  private initialization?: Promise<void>;
  constructor(readonly directory=resolve(process.env.FIGMA_BRIDGE_PREVIEW_DIR??(process.env.FIGMA_BRIDGE_DATA_DIR?resolve(process.env.FIGMA_BRIDGE_DATA_DIR,'previews'):'.bridge/previews'))) {}
  private initialize() {
    return this.initialization ??= (async () => {
      await mkdir(this.directory,{recursive:true});
      // These IDs cannot be served after restart. Remove only our generated PNGs.
      for (const name of await readdir(this.directory)) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i.test(name)) await unlink(resolve(this.directory,name));
      }
    })();
  }
  async save(bytes: Buffer) {
    const size=validatePng(bytes),id=randomUUID(),path=resolve(this.directory,`${id}.png`);
    await this.initialize(); await writeFile(path,bytes,{flag:'wx'}); this.files.set(id,path);
    if (this.files.size>20) { const oldest=this.files.keys().next().value!,oldPath=this.files.get(oldest)!;this.files.delete(oldest);await unlink(oldPath).catch(()=>{}); }
    return {id,path,mimeType:'image/png',bytes:bytes.length,...size,resourceUri:`figma-bridge://preview/${id}`};
  }
  async read(id: string) { const path=this.files.get(id);if(!path)throw new Error('PREVIEW_NOT_FOUND');return readFile(path); }
}
