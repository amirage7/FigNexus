import { ExecuteInput, ReadInput, PreviewInput, ChunkInput, type FileContext, type Request, type Result, type NodeSummary,type RequestProgress } from '@bridge/protocol';
import type { z } from 'zod';
import { editBatch } from './editor';
import { PreviewManager } from './preview';
import {listBackups,restoreBackup} from './backups';
import {toNativePaints,toNativeEffects,serializePaints,serializeEffects} from './visual';
import {NativeImageUploads} from './image-upload';
import {createComponentsPages} from './components-pages';
import {createVariables} from './variables';
import {serializeBindings} from './binding-summary';
import {toNativeVectorPaths,serializeVectorPaths} from './vector';
import {isDesignWrite,DesignParams} from '@bridge/protocol';
type Api = Pick<PluginAPI, 'root' | 'currentPage' | 'getNodeByIdAsync' | 'createFrame' | 'createText' | 'createRectangle' | 'createEllipse' | 'createVector' | 'createLine' | 'loadFontAsync' | 'commitUndo' | 'base64Encode'>;
type Method = Exclude<Request['method'], 'ping'>;
type Summary = z.infer<typeof NodeSummary>;
const fail = (code: string): never => { throw new Error(code); };
function error(e: unknown) { return (e instanceof Error ? e.message : 'EXECUTION_FAILED').slice(0, 512); }
function onPage(node: BaseNode, page: PageNode) {
  let current: BaseNode | null = node;
  while (current) { if (current.id === page.id) return true; current = current.parent; }
  return false;
}
function editableParent(node: BaseNode | null, page: PageNode): PageNode | FrameNode {
  if (!node || !onPage(node, page) || !['PAGE','FRAME'].includes(node.type)) return fail('INVALID_PARENT');
  for (let current: BaseNode | null = node; current && current.type !== 'DOCUMENT'; current = current.parent) {
    if (current.type === 'INSTANCE' || ('locked' in current && current.locked)) return fail('PARENT_NOT_EDITABLE');
  }
  return node as PageNode | FrameNode;
}
async function summary(node: BaseNode, fields: z.infer<typeof ReadInput>['fields']): Promise<Summary> {
  const s: Summary = { id: node.id, type: node.type };
  if (fields.includes('name')) s.name = node.name.slice(0, 128);
  if (fields.includes('parentId') && node.parent) s.parentId = node.parent.id;
  if (fields.includes('geometry') && 'x' in node) { s.x = node.x; s.y = node.y; s.width = node.width; s.height = node.height; }
  if (fields.includes('characters') && node.type === 'TEXT') s.characters = node.characters.slice(0, 256);
  if (fields.includes('fills') && 'fills' in node && Array.isArray(node.fills)) s.fills = serializePaints(node.fills).map(p=>p.type==='SOLID'&&p.visible!==false&&(!p.blendMode||p.blendMode==='NORMAL')?{...p.color,a:p.opacity??1}:p);
  if(fields.includes('vectorPaths')&&node.type==='VECTOR'){const v=serializeVectorPaths(node.vectorPaths);s.vectorPaths=v.vectorPaths;if(v.vectorPathsTruncated)s.vectorPathsTruncated=true;}
  if(fields.includes('strokes')&&'strokes'in node){s.strokes=serializePaints(node.strokes);if(typeof node.strokeWeight==='number')s.strokeWeight=node.strokeWeight;if(node.type==='LINE'||node.type==='VECTOR'){s.strokeCap=typeof node.strokeCap==='string'&&['NONE','ROUND','SQUARE'].includes(node.strokeCap)?node.strokeCap as 'NONE'|'ROUND'|'SQUARE':'MIXED';s.strokeJoin=typeof node.strokeJoin==='string'&&['MITER','ROUND','BEVEL'].includes(node.strokeJoin)?node.strokeJoin as 'MITER'|'ROUND'|'BEVEL':'MIXED';}}
  if(fields.includes('geometry')&&'rotation'in node)s.rotation=node.rotation;
  if(fields.includes('effects')&&'effects'in node)s.effects=serializeEffects(node.effects);
  if(fields.includes('boundVariables')&&'boundVariables'in node&&node.boundVariables){const b=serializeBindings(node.boundVariables);s.boundVariables=b.bindings;if(b.truncated)s.bindingsTruncated=true;}
  if(fields.includes('component')&&node.type==='COMPONENT')s.componentId=node.id;
  if(fields.includes('component')&&node.type==='INSTANCE'){const main=await node.getMainComponentAsync();if(main)s.mainComponentId=main.id;}
  if (fields.includes('childCount') && 'children' in node) s.childCount = node.children.length;
  if (fields.includes('locked') && 'locked' in node) s.locked = node.locked;
  if (node.type === 'FRAME') s.layoutMode = node.layoutMode;
  // A single complex node must never make pagination stall at the same cursor.
  for(const field of ['vectorPaths','fills','strokes','effects','boundVariables','characters'] as const){
    if(JSON.stringify(s).length*3<=35000)break;
    if(s[field]!==undefined){delete s[field];s.fieldsTruncated=[...(s.fieldsTruncated??[]),field];if(field==='vectorPaths')s.vectorPathsTruncated=true;}
  }
  return s;
}

export function createExecutor(api: Api, canWrite: () => boolean, getContext?: () => FileContext, deleteAllowed: () => boolean = () => false,progress:(stage:RequestProgress['stage'])=>void=()=>{}) {
  const context = () => getContext?.() ?? { instanceId: 'executor', document: { id: api.root.id, name: api.root.name }, page: { id: api.currentPage.id, name: api.currentPage.name }, writeEnabled: canWrite() };
  const previews = new PreviewManager(api,progress);
  const images=new NativeImageUploads(api as unknown as PluginAPI,canWrite,context);
  const execute=async (method: Method, raw: unknown): Promise<Extract<Result,{ok:true}>['data']> => {
    if(method==='execute'||method==='restore_backup'||method==='image_upload'||(method==='design'&&isDesignWrite(DesignParams.parse(raw))))previews.invalidate();
    if(method==='design'){
      const action=(raw as {action?:string})?.action;
      return action?.startsWith('variable')||action==='collection_create'?createVariables(api as unknown as PluginAPI,canWrite,context)(raw):createComponentsPages(api as unknown as PluginAPI,canWrite,context)(raw);
    }
    if(method==='image_upload'){const image=await images.handle(raw);return {context:context(),complete:true,created:[],refs:{},completed:[0],backups:[],skipped:[],image};}
    if(method==='list_backups')return listBackups(api,raw,context);
    if(method==='restore_backup')return restoreBackup(api,raw,canWrite,context);
    if (method === 'export_preview') return previews.export(PreviewInput.parse(raw));
    if (method === 'preview_chunk') return previews.chunk(ChunkInput.parse(raw));
    const page = api.currentPage;
    if (method === 'execute') {
      if (!canWrite()) return fail('WRITE_DISABLED');
      const batch = ExecuteInput.parse(raw);
      if (batch.operations.some(op => op.op !== 'create')) return editBatch(api, batch, canWrite, context, async (b): Promise<z.infer<typeof import('@bridge/protocol').ExecuteResult>> => await createExecutor(api,canWrite,getContext)('execute',b) as z.infer<typeof import('@bridge/protocol').ExecuteResult>, deleteAllowed());
      const operations = batch.operations.filter(op => op.op === 'create');
      const deadline = Date.now() + 15000;
      const refs: Record<string, string> = Object.create(null);
      const definitions = new Map<string, number>();
      const parents = new Map<number, PageNode | FrameNode>();
      for (let i = 0; i < operations.length; i++) {
        const ref = operations[i].ref;
        if (ref) { if (definitions.has(ref)) return fail('DUPLICATE_REF'); definitions.set(ref, i); }
      }
      const order: number[] = [], visiting = new Set<number>(), done = new Set<number>();
      const visit = async (i: number): Promise<void> => {
        if (done.has(i)) return;
        if (visiting.has(i)) return fail('REF_CYCLE');
        visiting.add(i);
        const parent = operations[i].parent;
        if (parent?.startsWith('$')) {
          const index = definitions.get(parent.slice(1));
          if (index === undefined) return fail('UNKNOWN_REF');
          if (operations[index].type !== 'FRAME') return fail('INVALID_PARENT');
          await visit(index);
        } else parents.set(i, editableParent(parent ? await api.getNodeByIdAsync(parent) : page, page));
        visiting.delete(i); done.add(i); order.push(i);
      };
      for (let i = 0; i < operations.length; i++) await visit(i);
      const created: { index: number; id: string; type: string; ref?: string }[] = [];
      let failed: { index: number; code: string; message: string } | undefined;
      for (const index of order) {
        const op = operations[index];
        let node: SceneNode | undefined;
        try {
          const font = op.font ?? { family: 'Inter', style: 'Regular' };
          if (op.type === 'TEXT'){progress('font-loading');await api.loadFontAsync(font);progress('font-ready');}
          if (!canWrite()) return fail('WRITE_DISABLED');
          if (api.currentPage.id !== page.id) return fail('PAGE_CHANGED');
          if (Date.now() > deadline) return fail('EXECUTION_DEADLINE');
          const parent = editableParent(op.parent?.startsWith('$') ? await api.getNodeByIdAsync(refs[op.parent.slice(1)]) : parents.get(index)!, page);
          // Recheck consent/page after asynchronous parent lookup, before any mutation.
          if (!canWrite() || api.currentPage.id !== page.id) return fail('PERMISSION_OR_PAGE_CHANGED');
          if (Date.now() > deadline) return fail('EXECUTION_DEADLINE');
          node = op.type === 'FRAME' ? api.createFrame() : op.type === 'TEXT' ? api.createText() : op.type === 'RECTANGLE' ? api.createRectangle() : op.type==='ELLIPSE'?api.createEllipse():op.type==='VECTOR'?api.createVector():api.createLine();
          parent.appendChild(node);
          if (op.name !== undefined) node.name = op.name;
          if(node.type==='VECTOR'){node.vectorPaths=toNativeVectorPaths(op.vectorPaths);node.strokes=[];}
          node.x = op.x ?? 0; node.y = op.y ?? 0;
          if (node.type === 'TEXT') {
            node.fontName = font; node.fontSize = op.fontSize ?? 16; node.characters = op.characters ?? '';
            if (op.width !== undefined || op.height !== undefined) { node.textAutoResize = 'NONE'; node.resize(op.width ?? node.width, op.height ?? node.height); }
          } else if(node.type==='VECTOR'){if(op.width!==undefined||op.height!==undefined)node.resize(op.width??node.width,op.height??node.height);}else node.resize(op.width ?? 100, node.type==='LINE'?0:op.height ?? 100);
          if(op.rotation!==undefined)node.rotation=op.rotation;
          if(op.stroke){const {r,g,b,a}=op.stroke;node.strokes=[{type:'SOLID',color:{r,g,b},opacity:a??1}];}if(op.strokeWeight!==undefined)node.strokeWeight=op.strokeWeight;
          if(node.type==='VECTOR'||node.type==='LINE'){if(op.strokeCap!==undefined)node.strokeCap=op.strokeCap;if(op.strokeJoin!==undefined)node.strokeJoin=op.strokeJoin;}
          if (op.fill) { const { r,g,b,a } = op.fill; node.fills = [{ type: 'SOLID', color: { r,g,b }, opacity: a ?? 1 }]; }
          if(op.fills!==undefined)node.fills=toNativePaints(api as unknown as PluginAPI,op.fills);
          if(op.effects!==undefined)node.effects=toNativeEffects(op.effects);
          if (op.cornerRadius !== undefined && (node.type === 'FRAME' || node.type === 'RECTANGLE')) node.cornerRadius = op.cornerRadius;
          if (op.ref) refs[op.ref] = node.id;
          created.push({ index, id: node.id, type: node.type, ...(op.ref ? { ref: op.ref } : {}) });
        } catch (e) {
          if (node && !node.removed) node.remove();
          failed = { index, code: 'CREATE_FAILED', message: error(e) }; break;
        }
      }
      if (created.length) api.commitUndo();
      const completed = new Set(created.map(n => n.index));
      return { context: context(), complete: !failed, created: created.sort((a,b) => a.index - b.index), refs, ...(failed ? { failed } : {}), skipped: operations.map((_,i) => i).filter(i => !completed.has(i) && i !== failed?.index) };
    }
    const p = ReadInput.parse(raw);
    const candidates: BaseNode[] = [], missing: string[] = [];
    let truncated = false, scanned = 0;
    if (method === 'get_nodes') {
      if (!p.ids) return fail('IDS_REQUIRED');
      for (const id of p.ids) { const n = await api.getNodeByIdAsync(id); if (n && onPage(n, page)) candidates.push(n); else missing.push(id); }
      scanned = p.ids.length;
    } else if (method === 'get_selection') { candidates.push(...page.selection.slice(0, 10000)); scanned = candidates.length; truncated = page.selection.length > 10000; }
    else {
      const root = p.parentId ? await api.getNodeByIdAsync(p.parentId) : page;
      if (!root || !onPage(root, page) || !('children' in root)) return fail('INVALID_READ_ROOT');
      const stack: { node: BaseNode; depth: number }[] = [{ node: root, depth: 0 }];
      // Iterator frames avoid allocating the entire document or a wide child stack.
      const walk = (parent: BaseNode & ChildrenMixin, depth: number) => {
        for (const n of parent.children) {
          if (scanned >= 10000) { truncated = true; return; }
          scanned++;
          if ((!p.name || n.name.toLowerCase().includes(p.name.toLowerCase())) && (!p.types?.length || p.types.includes(n.type))) candidates.push(n);
          if (depth < p.depth && 'children' in n) walk(n, depth + 1);
          if (truncated) return;
        }
      };
      walk(stack[0].node as BaseNode & ChildrenMixin, 1);
    }
    if (api.currentPage.id !== page.id) return fail('PAGE_CHANGED');
    const nodes: Summary[] = [];
    let used = 0, offset = p.cursor;
    for (; offset < candidates.length && nodes.length < p.limit; offset++) {
      const n = await summary(candidates[offset], p.fields), size = JSON.stringify(n).length * 3;
      if(api.currentPage.id!==page.id)return fail('PAGE_CHANGED');
      if (used + size > 36000) break;
      used += size; nodes.push(n);
    }
    const pages = method === 'get_document' ? api.root.children.slice(0, 20).map(n => ({ id: n.id, name: n.name.slice(0,128) })) : undefined;
    return { context: context(), nodes, nextCursor: offset < candidates.length ? offset : null, truncated, scanned, ...(method === 'get_nodes' ? { missing } : {}), ...(pages ? { pages, pagesTruncated: api.root.children.length > 20 } : {}) };
  };
  return Object.assign(execute,{invalidatePreview:()=>previews.invalidate()});
}
