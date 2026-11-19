import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {Color,ExecuteInput,Patch} from '@bridge/protocol';

type Operation=(sessionId:string,requestId:string|undefined,method:'execute',params:z.infer<typeof ExecuteInput>)=>Promise<any>;

export function registerEditingTools(server:McpServer,operation:Operation){
 const id=z.string().min(1).max(128);
 const identity={sessionId:id,expectedPageId:id,requestId:id};
 const target={...identity,target:id};
 const xy=z.number().finite().min(-100000).max(100000).optional();
 const annotations={readOnlyHint:false,destructiveHint:true,idempotentHint:false};
 const common=' Requires local write permission and the expected current page. Use the SAME requestId and identical arguments to retrieve a cached result; never replay uncertain writes after plugin restart. Returns per-item actual node readback, status none/partial/complete and backup IDs. Coordinates x/y are relative to parentId.';
 const failure=(error:unknown)=>({isError:true,content:[{type:'text' as const,text:JSON.stringify({code:'EDIT_REQUEST_FAILED',status:'none',message:(error instanceof Error?error.message:'Invalid edit request').slice(0,512)})}]});
 async function edit(sessionId:string,expectedPageId:string,requestId:string,operations:unknown){
  try{
   const params=ExecuteInput.parse({expectedPageId,operations});
   // The plugin checks cached request IDs before page/write guards. Do not
   // block result retrieval here after a completed write changes local state.
   // Fresh writes are still checked by the executor against expectedPageId.
   return await operation(sessionId,requestId,'execute',params);
  }catch(error){return failure(error);}
 }
 server.registerTool('figma_clone_node',{
  description:'Clone a native node including the entire Frame hierarchy, text, shapes and image fills, preserving the source. Optional name, destination parent, x/y. Returns results[0].idMap mapping every source ID to its clone ID. Maximum 100 mapped nodes per batch; oversized trees fail before cloning.'+common,
  inputSchema:{...target,parent:id.optional(),name:z.string().max(512).optional(),x:xy,y:xy},annotations:{...annotations,destructiveHint:false}
 },async({sessionId,expectedPageId,requestId,...args})=>edit(sessionId,expectedPageId,requestId,[{op:'clone',...args}]));
 server.registerTool('figma_update_text',{
  description:'Replace existing TEXT characters directly without adding layers. Preserves font, size, color, alignment and auto resize unless explicitly overridden. Mixed style ranges retain character-index boundaries; new trailing text inherits the final range. Optional explicit self unlock; locked ancestors still block.'+common,
  inputSchema:{...target,characters:z.string().max(2048),fontFamily:z.string().min(1).max(128).optional(),fontStyle:z.string().min(1).max(128).optional(),fontSize:z.number().min(1).max(512).optional(),fill:Color.optional(),locked:z.boolean().optional()},annotations
 },async({sessionId,expectedPageId,requestId,target:node,fontFamily,fontStyle,...patch})=>{
  if((fontFamily===undefined)!==(fontStyle===undefined))return failure(Error('FONT_REQUIRES_FAMILY_AND_STYLE'));
  return edit(sessionId,expectedPageId,requestId,[{op:'update',target:node,patch:{...patch,...(fontFamily?{font:{family:fontFamily,style:fontStyle}}:{})}}]);
 });
 server.registerTool('figma_update_node',{
  description:'Update existing node properties. Only supplied fields change. locked:false explicitly unlocks the target itself. Use figma_edit_nodes for advanced fills, effects, layout or text formatting.'+common,
  inputSchema:{...target,name:z.string().max(512).optional(),x:xy,y:xy,width:z.number().min(.01).max(10000).optional(),height:z.number().min(0).max(10000).optional(),fill:Color.optional(),opacity:z.number().min(0).max(1).optional(),visible:z.boolean().optional(),locked:z.boolean().optional()},annotations
 },async({sessionId,expectedPageId,requestId,target:node,...patch})=>{
  if(!Object.keys(patch).length)return failure(Error('EMPTY_PATCH'));
  return edit(sessionId,expectedPageId,requestId,[{op:'update',target:node,patch:Patch.parse(patch)}]);
 });
 server.registerTool('figma_delete_nodes',{
  description:'Delete 1-25 existing current-page nodes with native backups. First returns CONFIRMATION_REQUIRED. Confirm in the local plugin, then retrieve the final execution result with the SAME requestId and identical targets; confirmation alone is not completion.'+common,
  inputSchema:{...identity,targets:z.array(id).min(1).max(25)},annotations
 },async({sessionId,expectedPageId,requestId,targets})=>edit(sessionId,expectedPageId,requestId,targets.map(target=>({op:'delete',target}))));
 server.registerTool('figma_edit_nodes',{
  description:'Apply 1-25 whitelisted operations from operationsJson, a JSON array (never code): create/update/clone/delete/reorder/reparent/layout. Clone accepts name,parent,x,y,ref. Later target "$copy/SOURCE_NODE_ID" resolves a cloned descendant, "$copy" the root. Update supports characters,font,fontSize,name,x,y,width,height,fill/fills,stroke,strokeWeight,effects,opacity,visible,locked. To remove fill and add a black 1px border, use [{"op":"update","target":"node-id","patch":{"fills":[],"stroke":{"r":0,"g":0,"b":0},"strokeWeight":1}}]. Stops after first failure and reports remaining items skipped. Delete requires local confirmation.'+common,
  inputSchema:{...identity,operationsJson:z.string().min(2).max(60000)},annotations
 },async({sessionId,expectedPageId,requestId,operationsJson})=>{
  try{return await edit(sessionId,expectedPageId,requestId,JSON.parse(operationsJson));}catch(error){return failure(error);}
 });
}
