import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {ImageFileImporter} from './image-import';
import {registerDrawingTools} from './drawing-tools';
import { Status, Result, ReadInput, ExecuteInput, PreviewInput, Request, ListBackupsInput, RestoreInput,DesignParams,DESIGN_READ_ACTIONS } from '@bridge/protocol';

export function createMcp(token: string, bridgeUrl = 'http://127.0.0.1:3055') {
  const parsed = new URL(bridgeUrl);
  if (parsed.origin !== 'http://127.0.0.1:3055') throw new Error('Only loopback Bridge on port 3055 is supported');
  const server = new McpServer({ name: 'figma-ai-bridge', version: '0.3.8' });
  async function call(path: string, body?: unknown) {
    const response = await fetch(parsed.origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path === '/v1/preview' ? 90000 : 25000) });
    const json = await response.json();
    if (!response.ok) throw new Error(`Bridge ${response.status}: ${(json as { code?: string }).code ?? 'ERROR'}`);
    return json;
  }
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('figma_get_status', { description: 'Get authenticated local Bridge status and active Figma plugin sessions. Offline if no live plugin.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false } }, async () => {
    try { return text(Status.parse(await call('/v1/status'))); }
    catch (e) { return { ...text({ online: false, code: 'BRIDGE_UNAVAILABLE', message: e instanceof Error ? e.message : 'Unknown error' }), isError: true }; }
  });
  server.registerTool('figma_ping', { description: 'Round-trip through the specified plugin main thread. Read-only connection test; no node edits.', inputSchema: { sessionId: z.string().min(1).max(128), requestId: z.string().min(1).max(128).optional() }, annotations: { readOnlyHint: true, destructiveHint: false } }, async ({ sessionId, requestId }) => {
    try { const result = Result.parse(await call('/v1/ping', { sessionId, requestId: requestId ?? randomUUID() })); return { ...text(result), isError: !result.ok }; }
    catch (e) { return { ...text({ code: 'REQUEST_FAILED', message: e instanceof Error ? e.message : 'Unknown error' }), isError: true }; }
  });
  const sessionFields = { sessionId: z.string().min(1).max(128), requestId: z.string().min(1).max(128).optional() };
  const images=new ImageFileImporter();
  server.registerTool('figma_import_image',{description:'Import an explicitly specified absolute local PNG/JPEG file (max2MiB) as a native Figma image asset. Sends bounded chunks through this plugin only, no external upload. Requires local edit permission and expectedPageId. Returns imageHash for IMAGE fills; stable requestId never replayed across plugin restart.',inputSchema:{sessionId:sessionFields.sessionId,expectedPageId:z.string().min(1).max(128),path:z.string().min(1).max(4096),requestId:z.string().min(1).max(110).optional()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},async({sessionId,expectedPageId,path,requestId})=>{
    try{
      const status=Status.parse(await call('/v1/status')),session=status.sessions.find(s=>s.sessionId===sessionId);
      if(!session||session.context.page.id!==expectedPageId)throw Error('SESSION_OR_PAGE_CHANGED');
      if(!session.context.writeEnabled)throw Error('WRITE_DISABLED');
      const result=await images.import({path,expectedPageId,requestId:requestId??randomUUID(),instanceId:session.context.instanceId},async(id,params)=>{
        const request=Request.parse({type:'request',requestId:id,method:'image_upload',params});
        const r=Result.parse(await call('/v1/request',{sessionId,request}));if(!r.ok)throw Error(r.error.code);return r;
      });
      return text(result);
    }catch(e){return {...text({code:'IMAGE_IMPORT_FAILED',message:e instanceof Error?e.message:'Image import failed'}),isError:true};}
  });
  const designTools:Record<z.infer<typeof DesignParams>['action'],string>={components_list:'figma_list_components',component_create:'figma_create_component',instance_create:'figma_create_instance',variables_list:'figma_list_variables',collection_create:'figma_create_variable_collection',variable_create:'figma_create_variable',variable_set:'figma_set_variable',variable_bind:'figma_bind_variable',variable_history:'figma_get_variable_history',variable_restore:'figma_restore_variable',pages_list:'figma_list_pages',page_create:'figma_create_page',page_switch:'figma_switch_page'};
  for(const option of DesignParams.options){
    const action=option.shape.action.value,{action:unused,...shape}=option.shape;
    const readOnly=(DESIGN_READ_ACTIONS as readonly string[]).includes(action);
    server.registerTool(designTools[action],{description:`${action}: bounded native Figma operation. Writes require local edit permission and exact expectedPageId; preserve original nodes and user variables. Stable requestId for writes, never replay after plugin restart.`,inputSchema:{...sessionFields,...shape},annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:readOnly}},async({sessionId,requestId,...params}:{sessionId:string;requestId?:string}&Record<string,unknown>)=>operation(sessionId,requestId,'design',{action,...params}));
  }
  server.registerTool('figma_list_backups',{description:'List versioned native backups on the current page; bounded scan and pagination. Legacy backups without metadata are excluded.',inputSchema:{...sessionFields,...ListBackupsInput.shape},annotations:{readOnlyHint:true,destructiveHint:false}},async({sessionId,requestId,...params})=>operation(sessionId,requestId,'list_backups',params));
  server.registerTool('figma_restore_backup',{description:'Restore a versioned native backup as a NEW COPY in an explicit current-page parent. Preserves the original and backup, needs local write permission. Use a stable requestId; never blindly replay after plugin restart. Returns actual new node ID.',inputSchema:{...sessionFields,...RestoreInput.shape},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},async({sessionId,requestId,...params})=>operation(sessionId,requestId,'restore_backup',params));
  server.registerTool('figma_get_audit_status',{description:'Read bounded redacted local audit status. Unresolved writes are paginated independently of the latest 50 records; follow unresolved.nextCursor for older requests. Does not replay requests or change Figma nodes.',inputSchema:{cursor:z.number().int().min(0).max(5000).default(0),limit:z.number().int().min(1).max(50).default(20)},annotations:{readOnlyHint:true,destructiveHint:false}},async({cursor,limit})=>{
    try{return text(await call(`/v1/audit/status?cursor=${cursor}&limit=${limit}`));}catch(e){return {...text({code:'AUDIT_UNAVAILABLE',message:e instanceof Error?e.message:'Unknown error'}),isError:true};}
  });
  async function operation(sessionId: string, requestId: string | undefined, method: Request['method'], params: unknown) {
    try {
      const request = Request.parse({ type: 'request', requestId: requestId ?? randomUUID(), method, params });
      const result = Result.parse(await call('/v1/request', { sessionId, request }));
      return { ...text(result), isError: !result.ok || ('complete' in result.data && !result.data.complete) };
    } catch (e) { return { ...text({ code: 'REQUEST_FAILED', message: e instanceof Error ? e.message : 'Unknown error' }), isError: true }; }
  }
  for (const method of ['get_document','get_selection','get_nodes','find_nodes'] as const) {
    server.registerTool(`figma_${method}`, { description: `${method}: bounded flat native-node summaries on the current page. Depth 1-10, limit 1-50, offset cursor, requested fields. Re-read after edits. get_document also returns up to 20 page identities; find_nodes scans at most 10000 nodes within depth.`, inputSchema: { ...ReadInput.shape, ...sessionFields, ...(method === 'get_nodes' ? { ids: z.array(z.string().min(1).max(128)).min(1).max(50) } : {}) }, annotations: { readOnlyHint: true, destructiveHint: false } }, async ({ sessionId, requestId, ...params }) => operation(sessionId, requestId, method, params));
  }
  registerDrawingTools(server, call, operation);
  server.registerTool('figma_execute', { description: 'Up to 25 whitelisted create/update/clone/reparent/reorder/delete/layout operations on current-page FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR. Vectors require bounded structured M/L/C/Q/Z commands; no raw SVG. Paths and round strokes remain natively editable. Local write permission required. Create-only batches support forward $ref; mixed batches reference earlier results. Existing targets get bounded native backups. Delete first returns CONFIRMATION_REQUIRED; the human must confirm and execute the exact batch locally within 5 minutes. Then use the SAME requestId/payload to retrieve the final cached result; acceptance alone is not completion. Stable write IDs are retained for this plugin run (256 maximum); evicted results refuse replay. Never retry uncertain writes after plugin restart. Partial results include completed/skipped and backup IDs. No arbitrary code.', inputSchema: { ...ExecuteInput.shape, ...sessionFields }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ sessionId, requestId, ...params }) => operation(sessionId, requestId, 'execute', params));
  async function imageBytes(id: string) {
    const safe=z.string().uuid().parse(id);
    const response=await fetch(parsed.origin+`/v1/previews/${safe}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('PREVIEW_NOT_FOUND');return Buffer.from(await response.arrayBuffer()).toString('base64');
  }
  server.registerTool('figma_export_preview',{description:'Export a current-page native Frame as bounded PNG (max edge 256-2048, default1024, max2MiB). Returns actual MCP image, local file path and resource URI. No node edits.',inputSchema:{sessionId:sessionFields.sessionId,...PreviewInput.shape},annotations:{readOnlyHint:true,destructiveHint:false}},async({sessionId,...params})=>{
    try {
      const meta=z.object({id:z.string().uuid(),path:z.string(),mimeType:z.literal('image/png'),bytes:z.number().max(2097152),width:z.number().max(2048),height:z.number().max(2048),resourceUri:z.string()}).strict().parse(await call('/v1/preview',{sessionId,params}));
      return {content:[{type:'text' as const,text:JSON.stringify(meta)},{type:'image' as const,mimeType:'image/png',data:await imageBytes(meta.id)}]};
    } catch(e){const detail=e instanceof Error?e.message:'Unknown error';const pending=detail.includes('PREVIEW_PENDING'),busy=detail.includes('PREVIEW_NATIVE_BUSY');return {...text({code:pending?'PREVIEW_PENDING':busy?'PREVIEW_NATIVE_BUSY':'PREVIEW_FAILED',message:pending?'Figma原生导出仍在等待渲染，任务已保留。稍后以相同nodeId/maxSize重试；若Figma在后台，可保持前台后继续取回。':busy?'另一项原生导出尚未返回；不要重复创建任务，请等待或重试原节点。':detail}),isError:true};}
  });
  server.registerResource('figma-preview',new ResourceTemplate('figma-bridge://preview/{id}',{list:undefined}),{mimeType:'image/png',description:'Authenticated local exported Figma PNG'},async(uri,{id})=>({contents:[{uri:uri.href,mimeType:'image/png',blob:await imageBytes(String(id))}]}));
  return server;
}
