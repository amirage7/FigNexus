import {afterEach, describe, expect, it, vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcp} from '../packages/mcp-server/src/server';
import {createExecutor} from '../apps/figma-plugin/src/executor';
import {fixture} from './figma-fixture';

const connections: {client: Client; server: ReturnType<typeof createMcp>}[] = [];
afterEach(async () => {
  for (const {client, server} of connections.splice(0)) {await client.close(); await server.close();}
  vi.unstubAllGlobals();
});
async function setup(writeEnabled = true, pageId = 'p') {
  const f = fixture(), execute = createExecutor(f.api, () => writeEnabled);
  const context = {instanceId:'fixture',document:{id:'0',name:'Test'},page:{id:pageId,name:'Page'},writeEnabled};
  const dispatched: any[] = [];
  const hooks = {beforeDispatch: () => {}};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/status')) return Response.json({version:1,online:true,permissions:['read','create'],sessions:[{sessionId:'session',transport:'ws',context,lastSeen:Date.now()}]});
    const {request} = JSON.parse(String(init?.body)); dispatched.push(request);
    hooks.beforeDispatch();
    const data = await execute(request.method, request.params);
    return Response.json({type:'result',requestId:request.requestId,ok:true,data});
  }));
  const server = createMcp('test'), client = new Client({name:'drawing-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  connections.push({client,server});
  await Promise.all([server.connect(a),client.connect(b)]);
  const call = async (name: string, args: Record<string,unknown>) => {
    const result = await client.callTool({name,arguments:{sessionId:'session',expectedPageId:'p',...args}});
    return {result, body:JSON.parse((result.content as {text:string}[])[0].text)};
  };
  return {f,client,call,dispatched,hooks};
}
describe('drawing tools independent of figma_execute discovery', () => {
  it('publishes small creation schemas and non-destructive annotations', async () => {
    const {client} = await setup(); const {tools} = await client.listTools();
    for (const name of ['figma_create_frame','figma_create_text','figma_create_rectangle','figma_create_nodes']) {
      const tool = tools.find(t => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations).toMatchObject({readOnlyHint:false,destructiveHint:false});
      expect(JSON.stringify(tool!.inputSchema).length).toBeLessThan(4500);
    }
    expect(tools.some(t => t.name === 'figma_execute')).toBe(true);
  });
  it('creates real native frame, text and rectangle through the existing executor', async () => {
    const {f,call,dispatched} = await setup();
    const frame = await call('figma_create_frame',{requestId:'frame-1',name:'Slide',width:960,height:540});
    expect(frame.result.isError).not.toBe(true);
    const parent = frame.body.data.created[0].id;
    const text = await call('figma_create_text',{parent,characters:'Editable title',fontSize:32,fontFamily:'Inter',fontStyle:'Bold'});
    const rect = await call('figma_create_rectangle',{parent,width:200,height:80,fill:{r:1,g:0,b:0}});
    expect(f.nodes.get(parent)).toMatchObject({type:'FRAME',width:960,height:540});
    expect(f.nodes.get(text.body.data.created[0].id)).toMatchObject({type:'TEXT',characters:'Editable title',fontName:{family:'Inter',style:'Bold'}});
    expect(f.nodes.get(rect.body.data.created[0].id).parent.id).toBe(parent);
    expect(dispatched[0]).toMatchObject({method:'execute',requestId:'frame-1',params:{operations:[{op:'create',type:'FRAME',parent:'p'}]}});
  });
  it('creates a bounded batch with forward references and anchors roots to expected page', async () => {
    const {call,dispatched,f} = await setup();
    const {body,result} = await call('figma_create_nodes',{nodesJson:JSON.stringify([
      {type:'TEXT',parent:'$slide',characters:'Batch title'}, {type:'FRAME',ref:'slide',width:960,height:540}
    ])});
    expect(result.isError).not.toBe(true); expect(body.data.complete).toBe(true);
    expect(f.nodes.get(body.data.created.find((n:any)=>n.type==='TEXT').id).parent.id).toBe(body.data.refs.slide);
    expect(dispatched[0].params.operations[1].parent).toBe('p');
  });
  it.each([[false,'p','WRITE_DISABLED'],[true,'other','SESSION_OR_PAGE_CHANGED']])('blocks permission/page mismatch before dispatch', async (enabled: boolean,page: string,code: string) => {
    const {call,dispatched} = await setup(enabled as boolean,page as string);
    const {result,body} = await call('figma_create_frame',{});
    expect(result.isError).toBe(true);expect(body.message).toContain(code);expect(dispatched).toEqual([]);
  });
  it('rejects a page switch between status and execution even with an explicit parent on the new page', async () => {
    const {call,f,hooks} = await setup();
    const parent = f.make('FRAME');
    const otherPage = {...f.page,id:'other',children:[parent]}; parent.parent = otherPage;
    hooks.beforeDispatch = () => {f.api.currentPage = otherPage;};
    const before = f.nodes.size;
    const {result} = await call('figma_create_rectangle',{parent:parent.id});
    expect(result.isError).toBe(true); expect(f.nodes.size).toBe(before);
  });
  it.each(['{broken','[]',JSON.stringify([{op:'delete',target:'existing'}]),JSON.stringify([{type:'FRAME',code:'eval()'}]),JSON.stringify(Array.from({length:26},()=>({type:'FRAME'})))])('rejects invalid creation data before dispatch: %s', async (nodesJson: string) => {
    const {call,dispatched} = await setup();
    const {result} = await call('figma_create_nodes',{nodesJson});
    expect(result.isError).toBe(true);expect(dispatched).toEqual([]);
  });
});
