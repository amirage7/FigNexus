import {prepareInstalledPlugin} from './plugin-config.mjs';
const [installDir,dataDir,...extra]=process.argv.slice(2);
if(!installDir||!dataDir)throw Error('Specify installation and data directories');
if(extra.length&&!(extra.length===2&&extra[0]==='--reuse-manifest'))throw Error('Optional input: --reuse-manifest EXISTING_MANIFEST');
console.log(JSON.stringify(await prepareInstalledPlugin(installDir,dataDir,undefined,extra[1])));
