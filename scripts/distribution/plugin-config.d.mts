export function localManifest(current:Record<string,unknown>,generated:unknown):Record<string,unknown>;
export function configureLocalPlugin(targetPath:string,generatedPath:string):Promise<{changed:boolean;path:string;backup?:string}>;
