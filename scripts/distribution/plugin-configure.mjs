import {configureLocalPlugin} from './plugin-config.mjs';
const [target,source]=process.argv.slice(2);if(!target)throw Error('Specify the installed manifest path');
const result=await configureLocalPlugin(target,source||undefined);
console.log(JSON.stringify(result));
