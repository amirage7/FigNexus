export interface ConfigOptions {codexHome:string;installDir:string;dataDir:string;previous?:ConfigOptions}
export function managedEntry(options:ConfigOptions):{command:string;args:string[];cwd:string;startup_timeout_sec:number;env:Record<string,string>};
export function planConfig(original:string,options:ConfigOptions,remove?:boolean):string;
export function installConfig(options:ConfigOptions):Promise<{changed:boolean;backup?:string}>;
export function uninstallConfig(options:ConfigOptions):Promise<{changed:boolean;backup?:string}>;
