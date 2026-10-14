import { z } from 'zod';
import {identity,id,Color,FileContext} from './common';
import {FillsSchema,PaintSchema,EffectsSchema,ImageUploadInput,ImageUploadState} from './visual';
import {DesignParams,DesignOutput,isDesignWrite,BoundVariablesSchema} from './design';
import {VectorPathsInputSchema,NativeVectorPathsSchema,StrokeCapSchema,StrokeJoinSchema} from './vector';
export * from './vector';
export * from './visual';
export * from './design';
export {identity,id,Color,FileContext} from './common';
export const VERSION = 1 as const;
export const Fields = z.enum(['name','parentId','geometry','characters','fills','childCount','locked','effects','boundVariables','component','vectorPaths','strokes']);
export const ReadInput = z.object({ cursor: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(20), depth: z.number().int().min(1).max(10).default(2), fields: z.array(Fields).max(10).default(['name','parentId','geometry','childCount']), ids: z.array(id).min(1).max(50).optional(), parentId: id.optional(), name: z.string().max(128).optional(), types: z.array(z.string().min(1).max(64)).max(20).optional() }).strict();
export const Creation = z.object({ vectorPaths:VectorPathsInputSchema.optional(),strokeCap:StrokeCapSchema.optional(),strokeJoin:StrokeJoinSchema.optional(),rotation:z.number().finite().min(-360).max(360).optional(),stroke:Color.optional(),strokeWeight:z.number().min(0).max(100).optional(), op: z.literal('create'), type: z.enum(['FRAME','TEXT','RECTANGLE','ELLIPSE','LINE','VECTOR']), ref: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional(), parent: id.optional(), name: z.string().max(512).optional(), x: z.number().finite().min(-100000).max(100000).optional(), y: z.number().finite().min(-100000).max(100000).optional(), width: z.number().finite().min(0.01).max(10000).optional(), height: z.number().finite().min(0).max(10000).optional(), characters: z.string().max(2048).optional(), font: z.object({ family: z.string().min(1).max(128), style: z.string().min(1).max(128) }).strict().optional(), fontSize: z.number().min(1).max(512).optional(), fill: Color.optional(), fills: FillsSchema.optional(), effects: EffectsSchema.optional(), cornerRadius: z.number().min(0).max(5000).optional() }).strict().superRefine((v, ctx) => {
  if(v.type==='VECTOR'&&!v.vectorPaths)ctx.addIssue({code:'custom',message:'VECTOR requires structured paths'});
  if(v.type!=='VECTOR'&&v.vectorPaths)ctx.addIssue({code:'custom',message:'Paths require VECTOR'});
  if(!['LINE','VECTOR'].includes(v.type)&&(v.strokeCap!==undefined||v.strokeJoin!==undefined||v.rotation!==undefined||v.height===0))ctx.addIssue({code:'custom',message:'Geometry attributes require LINE or VECTOR'});
  if(v.type==='LINE'&&v.height!==undefined&&v.height!==0)ctx.addIssue({code:'custom',message:'LINE height must be zero'});
  if(v.fill&&v.fills!==undefined)ctx.addIssue({code:'custom',message:'Use fill or fills, not both'});
  if (v.type !== 'TEXT' && (v.characters !== undefined || v.font || v.fontSize !== undefined)) ctx.addIssue({ code: 'custom', message: 'Text attributes require TEXT' });
  if (!['FRAME','RECTANGLE'].includes(v.type) && v.cornerRadius !== undefined) ctx.addIssue({ code: 'custom', message: 'Corner radius requires FRAME or RECTANGLE' });
});
export const Patch = z.object({ vectorPaths:VectorPathsInputSchema.optional(),strokeCap:StrokeCapSchema.optional(),strokeJoin:StrokeJoinSchema.optional(),rotation:z.number().finite().min(-360).max(360).optional(), name: z.string().max(512).optional(), x: z.number().finite().min(-100000).max(100000).optional(), y: z.number().finite().min(-100000).max(100000).optional(), width: z.number().min(.01).max(10000).optional(), height: z.number().min(0).max(10000).optional(), characters: z.string().max(2048).optional(), font: z.object({ family: z.string().min(1).max(128), style: z.string().min(1).max(128) }).strict().optional(), fontSize: z.number().min(1).max(512).optional(), fill: Color.optional(), fills: FillsSchema.optional(), effects: EffectsSchema.optional(), stroke: Color.optional(), strokeWeight: z.number().min(0).max(100).optional(), cornerRadius: z.number().min(0).max(5000).optional(), opacity: z.number().min(0).max(1).optional(), visible: z.boolean().optional() }).strict().superRefine((v,c)=>{if(v.fill&&v.fills!==undefined)c.addIssue({code:'custom',message:'Use fill or fills, not both'});});
export const Layout = z.object({ direction: z.enum(['NONE','HORIZONTAL','VERTICAL']), gap: z.number().min(0).max(1000).optional(), padding: z.number().min(0).max(1000).optional(), paddingTop: z.number().min(0).max(1000).optional(), paddingBottom: z.number().min(0).max(1000).optional(), paddingLeft: z.number().min(0).max(1000).optional(), paddingRight: z.number().min(0).max(1000).optional(), primaryAlign: z.enum(['MIN','CENTER','MAX','SPACE_BETWEEN']).optional(), counterAlign: z.enum(['MIN','CENTER','MAX']).optional(), primarySizing: z.enum(['FIXED','AUTO']).optional(), counterSizing: z.enum(['FIXED','AUTO']).optional() }).strict();
export const Operation = z.union([Creation,
  z.object({ op: z.literal('update'), target: id, patch: Patch }).strict(),
  z.object({ op: z.literal('clone'), target: id, ref: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional(), parent: id.optional() }).strict(),
  z.object({ op: z.literal('reparent'), target: id, parent: id, index: z.number().int().min(0).max(10000).optional() }).strict(),
  z.object({ op: z.literal('reorder'), target: id, index: z.number().int().min(0).max(10000) }).strict(),
  z.object({ op: z.literal('delete'), target: id }).strict(),
  z.object({ op: z.literal('layout'), target: id, layout: Layout }).strict()
]);
export const ExecuteInput = z.object({ operations: z.array(Operation).min(1).max(25) }).strict();
export const ListBackupsInput = z.object({cursor:z.number().int().min(0).max(10000).default(0),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const RestoreInput = z.object({backupId:id,parentId:id,index:z.number().int().min(0).max(10000).optional()}).strict();
export const BackupMetadata = z.object({version:z.literal(1),backupId:id,nodeId:id,parentId:id,index:z.number().int().min(0).max(1000000),pageId:id,createdAt:z.string().datetime()}).strict();
export const BackupListResult = z.object({context:FileContext,backups:z.array(BackupMetadata).max(50),nextCursor:z.number().int().nullable(),truncated:z.boolean(),scanned:z.number().int()}).strict();
export const PreviewInput = z.object({ nodeId: id, maxSize: z.number().int().min(256).max(2048).default(1024) }).strict();
export const ChunkInput = z.object({ exportId: id, index: z.number().int().min(0).max(58) }).strict();
export const Request = z.discriminatedUnion('method', [
  z.object({ type: z.literal('request'), requestId: id, method: z.literal('ping') }).strict(),
  ...(['get_document','get_selection','get_nodes','find_nodes'] as const).map(method => z.object({ type: z.literal('request'), requestId: id, method: z.literal(method), params: ReadInput }).strict()),
  z.object({ type: z.literal('request'), requestId: id, method: z.literal('execute'), params: ExecuteInput }).strict()
  ,z.object({type:z.literal('request'),requestId:id,method:z.literal('list_backups'),params:ListBackupsInput}).strict()
  ,z.object({type:z.literal('request'),requestId:id,method:z.literal('restore_backup'),params:RestoreInput}).strict()
  ,z.object({ type: z.literal('request'), requestId: id, method: z.literal('export_preview'), params: PreviewInput }).strict()
  ,z.object({ type: z.literal('request'), requestId: id, method: z.literal('preview_chunk'), params: ChunkInput }).strict()
,z.object({type:z.literal('request'),requestId:id,method:z.literal('design'),params:DesignParams}).strict()
  ,z.object({type:z.literal('request'),requestId:id,method:z.literal('image_upload'),params:ImageUploadInput}).strict()
]);
export type Request = z.infer<typeof Request>;
export function isWriteRequest(request:Request){return request.method==='execute'||request.method==='restore_backup'||request.method==='image_upload'||request.method==='design'&&isDesignWrite(request.params);}
export const Poll = z.object({ requests: z.array(Request).max(1) }).strict();
export const NodeSummary = z.object({ fieldsTruncated:z.array(Fields).max(12).optional(), id, type: z.string().max(64), vectorPaths:NativeVectorPathsSchema.optional(),vectorPathsTruncated:z.boolean().optional(),strokes:z.array(z.union([Color,PaintSchema])).max(4).optional(),strokeWeight:z.number().finite().optional(),strokeCap:z.union([StrokeCapSchema,z.literal('MIXED')]).optional(),strokeJoin:z.union([StrokeJoinSchema,z.literal('MIXED')]).optional(),rotation:z.number().finite().optional(),name: z.string().max(512).optional(), parentId: id.optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), characters: z.string().max(512).optional(), fills: z.array(z.union([Color,PaintSchema])).max(4).optional(), effects:EffectsSchema.optional(), boundVariables:BoundVariablesSchema.optional(),bindingsTruncated:z.boolean().optional(), componentId:id.optional(), mainComponentId:id.optional(), childCount: z.number().int().optional(), locked: z.boolean().optional(), layoutMode: z.string().optional() }).strict();
export const ReadResult = z.object({ context: FileContext, nodes: z.array(NodeSummary).max(50), nextCursor: z.number().int().nullable(), truncated: z.boolean(), scanned: z.number().int(), missing: z.array(id).max(50).optional(), pages: z.array(identity).max(50).optional(), pagesTruncated: z.boolean().optional() }).strict();
export const ExecuteResult = z.object({ context: FileContext, complete: z.boolean(), created: z.array(z.object({ index: z.number().int(), id, type: z.string(), ref: z.string().optional() }).strict()).max(25), refs: z.record(id), completed: z.array(z.number().int()).max(25).optional(), backups: z.array(z.object({ nodeId: id, backupId: id, parentId: id, index: z.number().int() }).strict()).max(25).optional(), failed: z.object({ index: z.number().int(), code: z.string().max(64), message: z.string().max(512) }).strict().optional(), skipped: z.array(z.number().int()).max(25) }).strict();
export const DesignResult=ExecuteResult.extend({design:DesignOutput});
export const ImageUploadResult=ExecuteResult.extend({image:ImageUploadState});
export const PreviewMeta = z.object({ exportId: id, nodeId: id, totalBytes: z.number().int().min(1).max(2097152), chunks: z.number().int().min(1).max(59) }).strict();
export const PreviewChunk = z.object({ exportId: id, index: z.number().int().min(0).max(58), base64: z.string().min(1).max(48000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export const Result = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('result'), requestId: z.string().min(1).max(128), ok: z.literal(true), data: z.union([z.object({ pong: z.literal(true), context: FileContext.optional() }).strict(), ReadResult, ExecuteResult, PreviewMeta, PreviewChunk, BackupListResult,DesignResult,ImageUploadResult]), auditWarning:z.literal('AUDIT_WRITE_FAILED').optional() }).strict(),
  z.object({ type: z.literal('result'), requestId: z.string().min(1).max(128), ok: z.literal(false), error: z.object({ code: z.string().max(64), message: z.string().max(512) }).strict(), auditWarning:z.literal('AUDIT_WRITE_FAILED').optional() }).strict()
]);
export type Result = z.infer<typeof Result>;
export const Hello = z.object({ type: z.literal('hello'), version: z.literal(VERSION), token: z.string().min(32).max(256), context: FileContext }).strict();
export const Heartbeat = z.object({ type: z.literal('heartbeat'), context: FileContext }).strict();
export const RequestProgress = z.object({type:z.literal('progress'),requestId:id,stage:z.enum(['received','started','font-loading','font-ready','node-loading','node-ready','export-loading','export-ready','result-ready'])}).strict();
export type RequestProgress=z.infer<typeof RequestProgress>;
export const ClientMessage = z.union([Hello, Heartbeat, Result,RequestProgress]);
export const Welcome = z.object({ type: z.literal('welcome'), version: z.literal(VERSION), sessionId: z.string(), heartbeatMs: z.number(), leaseMs: z.number() }).strict();
export const ServerMessage = z.union([Welcome, Request, z.object({ type: z.literal('ack') }).strict(), z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict()]);
export const Status = z.object({ version: z.literal(VERSION), online: z.boolean(), permissions: z.array(z.enum(['read','create'])), sessions: z.array(z.object({ sessionId: z.string(), transport: z.enum(['ws','http']), context: FileContext, lastSeen: z.number() }).strict()) }).strict();
export const PingInput = z.object({ sessionId: z.string().min(1).max(128), requestId: z.string().min(1).max(128) }).strict();
export const OperationInput = z.object({ sessionId: id, request: Request }).strict();
export const SavedPairing=z.object({version:z.literal(1),token:z.string().min(32).max(256),mode:z.enum(['ws','http'])}).strict();
export const PairingCommand=z.union([z.object({type:z.literal('pairing-load'),requestId:id}).strict(),z.object({type:z.literal('pairing-forget'),requestId:id}).strict(),z.object({type:z.literal('pairing-save'),requestId:id,token:z.string().min(32).max(256),mode:z.enum(['ws','http'])}).strict()]);
export type PairingCommand=z.infer<typeof PairingCommand>;
export const PairingState=z.object({type:z.literal('pairing-state'),requestId:id,action:z.enum(['load','save','forget']),saved:z.boolean().optional(),token:z.string().min(32).max(256).optional(),mode:z.enum(['ws','http']).optional(),error:z.literal('STORAGE_UNAVAILABLE').optional()}).strict().superRefine((v,ctx)=>{if(v.token!==undefined&&(v.action!=='load'||v.saved!==true||!v.mode))ctx.addIssue({code:'custom',message:'Credentials only in successful local load'});});
export type PairingState=z.infer<typeof PairingState>;
export const PanelCommand=z.union([z.object({type:z.literal('panel-load')}).strict(),z.object({type:z.literal('panel-mode'),compact:z.boolean()}).strict()]);
export const PanelState=z.object({type:z.literal('panel-state'),compact:z.boolean(),error:z.literal('STORAGE_UNAVAILABLE').optional()}).strict();
export const UiMessage = z.union([PanelCommand,z.object({ type: z.literal('context-request') }).strict(), z.object({ type: z.literal('set-write'), enabled: z.boolean() }).strict(), z.object({ type: z.literal('confirm-delete'), requestId: id, confirmationId: id, approved: z.boolean() }).strict(), PairingCommand,Request]);
export const Confirmation = z.object({ type: z.literal('confirmation'), requestId: id, confirmationId: id, targets: z.array(id).max(25) }).strict();
export const ConfirmationState = z.object({type:z.literal('confirmation_state'),requestId:id,confirmationId:id,state:z.enum(['accepted','cancelled','invalid'])}).strict();
export const MainMessage = z.union([z.object({ type: z.literal('context'), context: FileContext }).strict(), Confirmation, ConfirmationState, Result,RequestProgress,PairingState,PanelState]);
