import {z} from 'zod';
export const id=z.string().min(1).max(128);
export const identity=z.object({id,name:z.string().max(512)}).strict();
export const Color=z.object({r:z.number().min(0).max(1),g:z.number().min(0).max(1),b:z.number().min(0).max(1),a:z.number().min(0).max(1).optional()}).strict();
export const FileContext=z.object({instanceId:id,document:identity,page:identity,writeEnabled:z.boolean().optional()}).strict();
export type FileContext=z.infer<typeof FileContext>;
