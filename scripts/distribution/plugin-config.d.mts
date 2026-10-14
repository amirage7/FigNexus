export function localManifest(current:Record<string,unknown>,generated?:unknown):Record<string,unknown>;
export function configureLocalPlugin(targetPath:string,generatedPath?:string):Promise<{changed:boolean;path:string;backup?:string}>;
export function inspectPluginIdentity(target:string,dataDir:string,previousInstallDir?:string,generatedPath?:string):Promise<{mode:string;path:string;id?:string}>;
export function prepareInstalledPlugin(installDir:string,dataDir:string,previousInstallDir?:string,generatedPath?:string):Promise<{mode:string;path:string;changed:boolean;backup?:string}>;
