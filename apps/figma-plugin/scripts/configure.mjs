import { readFile, writeFile } from 'node:fs/promises';
const id = process.argv[2];
if (!id || !/^\d+$/.test(id)) throw new Error('Usage: pnpm plugin:id <Figma-assigned numeric plugin ID>');
const path = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
manifest.id = id;
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
console.log('Plugin ID saved. Run pnpm build before importing dist/manifest.json.');
