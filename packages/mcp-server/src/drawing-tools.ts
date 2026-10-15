import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {Color, Creation, Status} from '@bridge/protocol';

type NativeCreate = z.infer<typeof Creation>;
type Operation = (sessionId: string, requestId: string | undefined, method: 'execute', params: {expectedPageId: string; operations: NativeCreate[]}) => Promise<any>;

// Keep these public schemas shallow. Some clients omit the larger union-based
// execute tool; creation must remain discoverable independently of that tool.
export function registerDrawingTools(server: McpServer, call: (path: string) => Promise<unknown>, operation: Operation) {
  const identity = {
    sessionId: z.string().min(1).max(128),
    expectedPageId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128).optional()
  };
  const geometry = {
    parent: z.string().min(1).max(128).optional(),
    name: z.string().max(512).optional(),
    x: z.number().finite().min(-100000).max(100000).optional(),
    y: z.number().finite().min(-100000).max(100000).optional(),
    width: z.number().min(.01).max(10000).optional(),
    height: z.number().min(.01).max(10000).optional(),
    fill: Color.optional()
  };
  const annotations = {readOnlyHint:false, destructiveHint:false, idempotentHint:false};
  async function create(sessionId: string, expectedPageId: string, requestId: string | undefined, nodes: NativeCreate[]) {
    const status = Status.parse(await call('/v1/status'));
    const session = status.sessions.find(s => s.sessionId === sessionId);
    if (!session || session.context.page.id !== expectedPageId) throw Error('SESSION_OR_PAGE_CHANGED');
    if (!session.context.writeEnabled) throw Error('WRITE_DISABLED');
    // Explicit root parents prevent a page switch between status and execution
    // from placing content on the newly active page. The plugin checks ancestry.
    return operation(sessionId, requestId, 'execute', {expectedPageId,operations:nodes.map(node => ({...node, parent:node.parent ?? expectedPageId}))});
  }
  const failure = (e: unknown) => ({content:[{type:'text' as const,text:JSON.stringify({code:'CREATE_FAILED',message:(e instanceof Error ? e.message : 'Creation failed').slice(0,512)})}],isError:true});
  for (const type of ['FRAME','TEXT','RECTANGLE'] as const) {
    const shape = type === 'TEXT' ? {
      ...identity,...geometry,characters:z.string().max(2048),fontSize:z.number().min(1).max(512).optional(),
      fontFamily:z.string().min(1).max(128).optional(),fontStyle:z.string().min(1).max(128).optional()
    } : {...identity,...geometry,cornerRadius:z.number().min(0).max(5000).optional()};
    server.registerTool(`figma_create_${type.toLowerCase()}`, {
      description:`Create one editable native ${type} on the expected current page. Requires local write permission. Coordinates are relative to parent (defaults to expectedPageId). Solid fill uses r/g/b/a in 0..1. Use a stable requestId; never replay uncertain writes after plugin restart. Returns real created node IDs.`,
      inputSchema:shape,annotations
    }, async (args: Record<string,unknown>) => {
      try {
        const {sessionId,expectedPageId,requestId,fontFamily,fontStyle,...attributes} = args as Record<string,unknown> & {sessionId:string;expectedPageId:string;requestId?:string;fontFamily?:string;fontStyle?:string};
        const node = Creation.parse({...attributes,op:'create',type,...(type === 'TEXT' && (fontFamily || fontStyle) ? {font:{family:fontFamily ?? 'Inter',style:fontStyle ?? 'Regular'}} : {})});
        return await create(sessionId,expectedPageId,requestId,[node]);
      } catch (e) {return failure(e);}
    });
  }
  server.registerTool('figma_create_nodes', {
    description:'Create 1-25 editable native nodes. nodesJson is a JSON array of creation objects, not code. Each object has type FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR, optional op:"create", ref, parent, name, x/y/width/height, fill:{r,g,b,a?}, characters/font/fontSize, cornerRadius, fills/effects or structured vectorPaths. Parent "$slide" refers to ref:"slide" in this batch (forward refs supported). Example: [{"type":"FRAME","ref":"slide","width":960,"height":540},{"type":"TEXT","parent":"$slide","characters":"Title","fontSize":32}]. Only creation is accepted; edits/deletes/code are rejected. Requires expected current page and local write permission. Stable requestId; never replay uncertain writes after plugin restart. Returns real IDs, refs, completed/skipped and partial failures.',
    inputSchema:{...identity,nodesJson:z.string().min(2).max(60000)},annotations
  }, async ({sessionId,expectedPageId,requestId,nodesJson}) => {
    try {
      const items: unknown = JSON.parse(nodesJson);
      const nodes = z.array(z.unknown()).min(1).max(25).parse(items).map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('INVALID_CREATE_NODE');
        return Creation.parse({op:'create',...item});
      });
      return await create(sessionId,expectedPageId,requestId,nodes);
    } catch (e) {return failure(e);}
  });
}
