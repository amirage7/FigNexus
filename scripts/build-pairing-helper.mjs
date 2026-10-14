import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../apps/bridge-server/package.json',import.meta.url));
await require('esbuild').build({entryPoints:[fileURLToPath(new URL('../apps/pairing-helper/src/index.ts',import.meta.url))],outfile:fileURLToPath(new URL('../apps/pairing-helper/dist/index.js',import.meta.url)),bundle:true,platform:'node',format:'esm',external:['zod']});
