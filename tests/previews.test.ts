import { it, expect } from 'vitest';
import { validatePng, PreviewStore } from '../apps/bridge-server/src/previews';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sample=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=','base64');
it('validates PNG signature and bounds before persisting',()=>{
  expect(validatePng(sample)).toEqual({width:1,height:1});
  expect(()=>validatePng(Buffer.from('not a png'))).toThrow('INVALID_PNG');
  const large=Buffer.from(sample);large.writeUInt32BE(2049,16);expect(()=>validatePng(large)).toThrow('INVALID_PNG_SIZE');
  expect(()=>validatePng(Buffer.alloc(2097153))).toThrow('INVALID_PNG');
});
it('never reads unregistered IDs or file paths',async()=>{
  await expect(new PreviewStore().read('../token')).rejects.toThrow('PREVIEW_NOT_FOUND');
});
it('cleans orphaned generated PNGs after restart and preserves unrelated files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'figma-preview-'));
  try {
    await writeFile(join(directory,'notes.txt'),'keep');
    const old=await new PreviewStore(directory).save(sample);
    const fresh=await new PreviewStore(directory).save(sample);
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['notes.txt',`${fresh.id}.png`]));
    expect(await readdir(directory)).not.toContain(`${old.id}.png`);
    expect(await new PreviewStore(directory).read(old.id).catch(e=>e.message)).toBe('PREVIEW_NOT_FOUND');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
