import { ExecuteInput, ExecuteResult, type FileContext } from '@bridge/protocol';
import type { z } from 'zod';
import {BACKUP_KEY,CONTAINER_KEY} from './backups';
import {toNativePaints,toNativeEffects} from './visual';
import {toNativeVectorPaths} from './vector';
import {assertPrivateData,editSnapshot,editError,boundExecution} from './edit-results';
import {textReplacement} from './text-edit';
type Api = Pick<PluginAPI, 'currentPage' | 'getNodeByIdAsync' | 'createFrame' | 'loadFontAsync' | 'commitUndo'>;
type Batch = z.infer<typeof ExecuteInput>;
type BatchResult = z.infer<typeof ExecuteResult>;
type Editable = FrameNode | TextNode | RectangleNode | EllipseNode | LineNode | VectorNode;
function fail(code: string): never { throw new Error(code); }
function inPage(n: BaseNode, page: PageNode) { for (let p: BaseNode | null = n; p; p = p.parent) if (p.id === page.id) return true; return false; }
function guard(n: BaseNode | null, page: PageNode, unlock=false): Editable {
  if (!n || n.removed || !inPage(n, page) || !['FRAME','TEXT','RECTANGLE','ELLIPSE','LINE','VECTOR'].includes(n.type)) return fail('INVALID_TARGET');
  if(unlock&&n.getPluginData(CONTAINER_KEY)==='1')return fail(`BACKUP_NOT_EDITABLE: ${n.id}`);
  for (let p: BaseNode | null = n; p && p.type !== 'DOCUMENT'; p = p.parent) { if(p.type==='INSTANCE')return fail(`TARGET_NOT_EDITABLE: ${p.id}`); if('locked'in p&&p.locked&&!(unlock&&p.id===n.id))return fail(`${p.id===n.id?'TARGET_LOCKED':'ANCESTOR_LOCKED'}: ${p.id}`); }
  return n as Editable;
}
function parentGuard(n: BaseNode | null, page: PageNode): FrameNode | PageNode {
  if (n?.id === page.id) return page;
  const node = guard(n, page); if (node.type !== 'FRAME') return fail('INVALID_PARENT'); return node;
}
function count(n: BaseNode, depth = 0): number {
  if (depth > 20) return fail('BACKUP_TOO_DEEP');
  let total = 1;
  if ('children' in n) for (const child of n.children) { total += count(child, depth + 1); if (total > 500) return fail('BACKUP_TOO_LARGE'); }
  return total;
}
export async function editBatch(api: Api, batch: Batch, canWrite: () => boolean, context: () => FileContext, create: (batch: unknown) => Promise<BatchResult>, deleteApproved: boolean): Promise<BatchResult> {
  const page = api.currentPage, deadline = Date.now() + 15000;
  const check = () => { if (!canWrite()) fail('WRITE_DISABLED'); if (page.id !== api.currentPage.id) fail('PAGE_CHANGED'); if (Date.now() > deadline) fail('EXECUTION_DEADLINE'); };
  check();
  if (batch.operations.some(op => op.op === 'delete') && !deleteApproved) fail('CONFIRMATION_REQUIRED');
  const refs: Record<string, string> = Object.create(null), completed: number[] = [], created: BatchResult['created'] = [], backups: NonNullable<BatchResult['backups']> = [];
  const results:NonNullable<BatchResult['results']>=[], cloneMaps:Record<string,Record<string,string>>=Object.create(null);
  let batchCloneCount=0,mappingBudget=0;
  const transient=new Map<string,BaseNode>();
  let backupFrame: FrameNode | undefined, backupCount = 0, failed: BatchResult['failed'];
  const resolve = (id:string) => {
    if(!id.startsWith('$'))return id;
    const [ref,source,...rest]=id.slice(1).split('/');
    if(rest.length)fail('INVALID_DESCENDANT_REF');
    return (source?cloneMaps[ref]?.[source]:refs[ref])??fail('UNKNOWN_REF_OR_FORWARD_EDIT_REF');
  };
  const saved = new Set<string>();
  const backup = (node: Editable) => {
    if(saved.has(node.id))return;
    for(let ancestor:BaseNode|null=node;ancestor;ancestor=ancestor.parent)if(created.some(n=>n.id===ancestor!.id))return;
    assertPrivateData(api,node);
    backupCount += count(node); if (backupCount > 2000) fail('BACKUP_BATCH_TOO_LARGE');
    const originalParent = node.parent!; if (!('children' in originalParent)) fail('INVALID_PARENT');
    const index = originalParent.children.findIndex(n => n.id === node.id);
    const copy = node.clone();transient.set(copy.id,copy);
    try {
      if (!backupFrame) { backupFrame = api.createFrame(); transient.set(backupFrame.id,backupFrame); backupFrame.name = `AI Bridge Backups · ${new Date().toISOString()}`; backupFrame.setPluginData(CONTAINER_KEY,'1'); backupFrame.visible = false; backupFrame.locked = true; }
      copy.setPluginData(BACKUP_KEY,JSON.stringify({version:1,backupId:copy.id,nodeId:node.id,parentId:originalParent.id,index,pageId:page.id,createdAt:new Date().toISOString()}));
      backupFrame.appendChild(copy); backups.push({ nodeId: node.id, backupId: copy.id, parentId: originalParent.id, index }); saved.add(node.id);transient.delete(copy.id);transient.delete(backupFrame.id);
    }catch(e){
      try{copy.remove();transient.delete(copy.id);}catch{}
      if(backupFrame&&!backupFrame.children.length){try{backupFrame.remove();transient.delete(backupFrame.id);backupFrame=undefined;}catch{}}
      throw e;
    }
  };
  for (let index = 0; index < batch.operations.length; index++) {
    const op = batch.operations[index];
    let active:Editable|undefined,before:string|undefined,attempted=false;
    const item:NonNullable<BatchResult['results']>[number]={index,op:op.op,status:'completed'};
    try {
      check();
      if (op.op === 'create') {
        if (op.ref && refs[op.ref]) fail('DUPLICATE_REF');
        const r = await create({ operations: [{ ...op, ...(op.parent ? { parent: resolve(op.parent) } : {}) }] });
        for (const n of r.created) created.push({ ...n, index }); Object.assign(refs, r.refs);
        const readback=r.results?.[0];if(readback){item.node=readback.node;item.residualIds=readback.residualIds;}
        if(!r.complete){attempted=r.status==='partial';throw new Error(r.failed?.message??'CREATE_FAILED');}
      } else {
        const node = guard(await api.getNodeByIdAsync(resolve(op.target)), page,op.op==='update'&&op.patch.locked===false); check();
        active=node;before=JSON.stringify(editSnapshot(node));
        if (op.op === 'update') {
          const p = op.patch;
          if ((p.characters !== undefined || p.font || p.fontSize !== undefined) && node.type !== 'TEXT') fail('TEXT_ATTRIBUTES_REQUIRE_TEXT');
          if (p.cornerRadius !== undefined && !['FRAME','RECTANGLE'].includes(node.type)) fail('CORNER_RADIUS_UNSUPPORTED');
          if (node.type === 'TEXT' && (p.characters !== undefined || p.font || p.fontSize !== undefined || p.width !== undefined || p.height !== undefined)) {
            const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : typeof node.fontName === 'object' ? [node.fontName] : [];
            if(!fonts.length)fail(`FONT_UNRESOLVED: ${node.id}`);
            const unique = new Map<string, FontName>(); for (const font of [...fonts, ...(p.font ? [p.font] : [])]) unique.set(JSON.stringify(font), font);
            for (const font of unique.values()) {try{await api.loadFontAsync(font);}catch{fail(`FONT_LOAD_FAILED: ${font.family} / ${font.style} (${node.id})`);}}
          }
          if(p.vectorPaths!==undefined&&node.type!=='VECTOR')fail('PATHS_REQUIRE_VECTOR');
          if(!['LINE','VECTOR'].includes(node.type)&&(p.strokeCap!==undefined||p.strokeJoin!==undefined||p.rotation!==undefined||p.height===0))fail('GEOMETRY_ATTRIBUTES_REQUIRE_VECTOR_OR_LINE');
          if(node.type==='LINE'&&p.height!==undefined&&p.height!==0)fail('LINE_HEIGHT_MUST_BE_ZERO');
          const nativePaths=p.vectorPaths!==undefined?toNativeVectorPaths(p.vectorPaths):undefined;
          const nativeFills=p.fills!==undefined?toNativePaints(api as unknown as PluginAPI,p.fills):undefined;
          const nativeEffects=p.effects!==undefined?toNativeEffects(p.effects):undefined;
          const replace=node.type==='TEXT'&&p.characters!==undefined?textReplacement(node,p.characters):undefined;
          check(); guard(node, page,p.locked===false); backup(node);attempted=true;
          if(p.locked===false)node.locked=false;
          if(node.type==='TEXT'){if(replace)replace();if(p.font)node.fontName=p.font;if(p.fontSize!==undefined)node.fontSize=p.fontSize;}
          const originalPosition={x:node.x,y:node.y};
          if(nativePaths&&node.type==='VECTOR'){node.vectorPaths=nativePaths;node.x=originalPosition.x;node.y=originalPosition.y;}
          if (p.name !== undefined) node.name = p.name;
          if (p.width !== undefined || p.height !== undefined) { if (node.type === 'TEXT') node.textAutoResize = 'NONE'; node.resize(p.width ?? node.width, p.height ?? node.height); }
          if (p.x !== undefined) node.x = p.x; if (p.y !== undefined) node.y = p.y;
          if (p.fill) { const { r,g,b,a } = p.fill; node.fills = [{ type: 'SOLID', color: { r,g,b }, opacity: a ?? 1 }]; }
          if(nativeFills!==undefined)node.fills=nativeFills;
          if(nativeEffects!==undefined)node.effects=nativeEffects;
          if (p.stroke) { const { r,g,b,a } = p.stroke; node.strokes = [{ type: 'SOLID', color: { r,g,b }, opacity: a ?? 1 }]; }
          if(p.rotation!==undefined)node.rotation=p.rotation;
          if(node.type==='LINE'||node.type==='VECTOR'){if(p.strokeCap!==undefined)node.strokeCap=p.strokeCap;if(p.strokeJoin!==undefined)node.strokeJoin=p.strokeJoin;}
          if (p.strokeWeight !== undefined) node.strokeWeight = p.strokeWeight;
          if (p.cornerRadius !== undefined && (node.type === 'FRAME' || node.type === 'RECTANGLE')) node.cornerRadius = p.cornerRadius;
          if (p.opacity !== undefined) node.opacity = p.opacity; if (p.visible !== undefined) node.visible = p.visible;
          if(p.locked===true)node.locked=true;
        } else if (op.op === 'layout') {
          if (node.type !== 'FRAME') fail('LAYOUT_REQUIRES_FRAME');
          backup(node);attempted=true; const l = op.layout, width = node.width, height = node.height; node.layoutMode = l.direction;
          if (l.gap !== undefined) node.itemSpacing = l.gap;
          for (const key of ['paddingTop','paddingBottom','paddingLeft','paddingRight'] as const) if (l[key] !== undefined || l.padding !== undefined) node[key] = l[key] ?? l.padding!;
          if (l.primaryAlign) node.primaryAxisAlignItems = l.primaryAlign;
          if (l.counterAlign) node.counterAxisAlignItems = l.counterAlign;
          if (l.primarySizing) node.primaryAxisSizingMode = l.primarySizing;
          if (l.counterSizing) node.counterAxisSizingMode = l.counterSizing;
          if (l.direction !== 'NONE') {
            const primary = node.primaryAxisSizingMode, counter = node.counterAxisSizingMode;
            const horizontal = l.direction === 'HORIZONTAL';
            const fixedWidth = (horizontal ? primary : counter) === 'FIXED';
            const fixedHeight = (horizontal ? counter : primary) === 'FIXED';
            // Enabling layout can reflow immediately; FIXED must keep the pre-edit dimension.
            if (fixedWidth || fixedHeight) {
              node.resizeWithoutConstraints(fixedWidth ? width : node.width, fixedHeight ? height : node.height);
              node.primaryAxisSizingMode = primary; node.counterAxisSizingMode = counter;
            }
          }
        } else if (op.op === 'clone') {
          if (op.ref && refs[op.ref]) fail('DUPLICATE_REF');
          const size=count(node);if(batchCloneCount+size>100)fail('CLONE_RESULT_TOO_LARGE');
          const sourceIds:string[]=[];const collect=(n:BaseNode)=>{sourceIds.push(n.id);if('children'in n)for(const child of n.children)collect(child);};collect(node);
          const budget=(JSON.stringify(sourceIds).length+size*136)*3;
          if(mappingBudget+budget>30000)fail('CLONE_RESULT_TOO_LARGE');
          const parent=parentGuard(op.parent?await api.getNodeByIdAsync(resolve(op.parent)):node.parent,page);check();guard(node,page);
          // Prevent parenting the clone inside its own source, which changes the source tree.
          for(let ancestor:BaseNode|null=parent;ancestor;ancestor=ancestor.parent)if(ancestor.id===node.id)fail('PARENT_CYCLE');
          const copy=node.clone();attempted=true;
          const idMap:Record<string,string>=Object.create(null);
          const mapTree=(source:BaseNode,dest:BaseNode)=>{
            if(source.type!==dest.type)fail('CLONE_STRUCTURE_MISMATCH');idMap[source.id]=dest.id;
            if('children'in source){if(!('children'in dest)||source.children.length!==dest.children.length)fail('CLONE_STRUCTURE_MISMATCH');for(let i=0;i<source.children.length;i++)mapTree(source.children[i],(dest as BaseNode&ChildrenMixin).children[i]);}
          };
          try{
            parent.appendChild(copy);mapTree(node,copy);
            if(op.name!==undefined)copy.name=op.name;if(op.x!==undefined)copy.x=op.x;if(op.y!==undefined)copy.y=op.y;
          }catch(e){try{copy.remove();attempted=false;}catch{item.residualIds=[copy.id];}throw e;}
          batchCloneCount+=size;mappingBudget+=budget;item.idMap=idMap;item.node=editSnapshot(copy);
          if(op.ref){refs[op.ref]=copy.id;cloneMaps[op.ref]=idMap;}
          created.push({index,id:copy.id,type:copy.type,...(op.ref?{ref:op.ref}:{})});
        } else if (op.op === 'reparent' || op.op === 'reorder') {
          const parent = parentGuard(op.op === 'reparent' ? await api.getNodeByIdAsync(resolve(op.parent)) : node.parent, page); check(); guard(node,page);
          for (let n: BaseNode | null = parent; n; n = n.parent) if (n.id === node.id) fail('PARENT_CYCLE');
          const at = op.index ?? parent.children.length; if (at > parent.children.length) fail('INDEX_OUT_OF_RANGE');
          backup(node);attempted=true; parent.insertChild(at, node);
        } else { backup(node);attempted=true; node.remove();item.deletedId=node.id; }
        if(!item.node&&!node.removed)item.node=editSnapshot(node);
      }
      completed.push(index);results.push(item);
    } catch (e) {
      const error=editError(e);failed={index,...error};item.status='failed';item.error=error;
      if(transient.size)item.residualIds=[...(item.residualIds??[]),...transient.keys()];
      if(active){if(active.removed)item.deletedId=active.id;else try{item.node=editSnapshot(active);}catch{}}
      item.mutated=!!item.residualIds?.length||attempted&&(!!item.deletedId||before!==JSON.stringify(item.node));
      results.push(item);break;
    }
  }
  if(completed.length||backups.length||results.some(r=>r.mutated))api.commitUndo();
  for(let i=results.length;i<batch.operations.length;i++)results.push({index:i,op:batch.operations[i].op,status:'skipped'});
  return boundExecution({ status:!failed?'complete':completed.length||backups.length||results.some(r=>r.mutated)?'partial':'none',results,context: context(), complete: !failed, created, refs, completed, backups, ...(failed ? { failed } : {}), skipped: batch.operations.map((_,i) => i).filter(i => !completed.includes(i) && i !== failed?.index) });
}
