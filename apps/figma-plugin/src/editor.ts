import { ExecuteInput, ExecuteResult, type FileContext } from '@bridge/protocol';
import type { z } from 'zod';
import {BACKUP_KEY,CONTAINER_KEY} from './backups';
import {toNativePaints,toNativeEffects} from './visual';
import {toNativeVectorPaths} from './vector';
type Api = Pick<PluginAPI, 'currentPage' | 'getNodeByIdAsync' | 'createFrame' | 'loadFontAsync' | 'commitUndo'>;
type Batch = z.infer<typeof ExecuteInput>;
type BatchResult = z.infer<typeof ExecuteResult>;
type Editable = FrameNode | TextNode | RectangleNode | EllipseNode | LineNode | VectorNode;
function fail(code: string): never { throw new Error(code); }
function inPage(n: BaseNode, page: PageNode) { for (let p: BaseNode | null = n; p; p = p.parent) if (p.id === page.id) return true; return false; }
function guard(n: BaseNode | null, page: PageNode): Editable {
  if (!n || n.removed || !inPage(n, page) || !['FRAME','TEXT','RECTANGLE','ELLIPSE','LINE','VECTOR'].includes(n.type)) return fail('INVALID_TARGET');
  for (let p: BaseNode | null = n; p && p.type !== 'DOCUMENT'; p = p.parent) if (p.type === 'INSTANCE' || ('locked' in p && p.locked)) return fail('TARGET_NOT_EDITABLE');
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
  let backupFrame: FrameNode | undefined, backupCount = 0, failed: BatchResult['failed'];
  const resolve = (id: string) => id.startsWith('$') ? refs[id.slice(1)] ?? fail('UNKNOWN_REF_OR_FORWARD_EDIT_REF') : id;
  const saved = new Set<string>();
  const backup = (node: Editable) => {
    if (saved.has(node.id) || created.some(n => n.id === node.id)) return;
    backupCount += count(node); if (backupCount > 2000) fail('BACKUP_BATCH_TOO_LARGE');
    const originalParent = node.parent!; if (!('children' in originalParent)) fail('INVALID_PARENT');
    const index = originalParent.children.findIndex(n => n.id === node.id);
    const copy = node.clone();
    try {
      if (!backupFrame) { backupFrame = api.createFrame(); backupFrame.name = `AI Bridge Backups · ${new Date().toISOString()}`; backupFrame.setPluginData(CONTAINER_KEY,'1'); backupFrame.visible = false; backupFrame.locked = true; }
      copy.setPluginData(BACKUP_KEY,JSON.stringify({version:1,backupId:copy.id,nodeId:node.id,parentId:originalParent.id,index,pageId:page.id,createdAt:new Date().toISOString()}));
      backupFrame.appendChild(copy); backups.push({ nodeId: node.id, backupId: copy.id, parentId: originalParent.id, index }); saved.add(node.id);
    } catch (e) { copy.remove(); throw e; }
  };
  for (let index = 0; index < batch.operations.length; index++) {
    const op = batch.operations[index];
    try {
      check();
      if (op.op === 'create') {
        if (op.ref && refs[op.ref]) fail('DUPLICATE_REF');
        const r = await create({ operations: [{ ...op, ...(op.parent ? { parent: resolve(op.parent) } : {}) }] });
        if (!r.complete) throw new Error(r.failed?.message ?? 'CREATE_FAILED');
        for (const n of r.created) created.push({ ...n, index }); Object.assign(refs, r.refs);
      } else {
        const node = guard(await api.getNodeByIdAsync(resolve(op.target)), page); check();
        if (op.op === 'update') {
          const p = op.patch;
          if ((p.characters !== undefined || p.font || p.fontSize !== undefined) && node.type !== 'TEXT') fail('TEXT_ATTRIBUTES_REQUIRE_TEXT');
          if (p.cornerRadius !== undefined && !['FRAME','RECTANGLE'].includes(node.type)) fail('CORNER_RADIUS_UNSUPPORTED');
          if (node.type === 'TEXT' && (p.characters !== undefined || p.font || p.fontSize !== undefined || p.width !== undefined || p.height !== undefined)) {
            const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : typeof node.fontName === 'object' ? [node.fontName] : [];
            const unique = new Map<string, FontName>(); for (const font of [...fonts, ...(p.font ? [p.font] : [])]) unique.set(JSON.stringify(font), font);
            for (const font of unique.values()) await api.loadFontAsync(font);
          }
          if(p.vectorPaths!==undefined&&node.type!=='VECTOR')fail('PATHS_REQUIRE_VECTOR');
          if(!['LINE','VECTOR'].includes(node.type)&&(p.strokeCap!==undefined||p.strokeJoin!==undefined||p.rotation!==undefined||p.height===0))fail('GEOMETRY_ATTRIBUTES_REQUIRE_VECTOR_OR_LINE');
          if(node.type==='LINE'&&p.height!==undefined&&p.height!==0)fail('LINE_HEIGHT_MUST_BE_ZERO');
          const nativePaths=p.vectorPaths!==undefined?toNativeVectorPaths(p.vectorPaths):undefined;
          const nativeFills=p.fills!==undefined?toNativePaints(api as unknown as PluginAPI,p.fills):undefined;
          const nativeEffects=p.effects!==undefined?toNativeEffects(p.effects):undefined;
          check(); guard(node, page); backup(node);
          if (node.type === 'TEXT') { if (p.font) node.fontName = p.font; if (p.fontSize !== undefined) node.fontSize = p.fontSize; if (p.characters !== undefined) node.characters = p.characters; }
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
        } else if (op.op === 'layout') {
          if (node.type !== 'FRAME') fail('LAYOUT_REQUIRES_FRAME');
          backup(node); const l = op.layout, width = node.width, height = node.height; node.layoutMode = l.direction;
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
          if (op.ref && refs[op.ref]) fail('DUPLICATE_REF'); count(node);
          const parent = parentGuard(op.parent ? await api.getNodeByIdAsync(resolve(op.parent)) : node.parent, page); check(); guard(node,page);
          const copy = node.clone(); try { parent.appendChild(copy); } catch (e) { copy.remove(); throw e; }
          if (op.ref) refs[op.ref] = copy.id; created.push({ index, id: copy.id, type: copy.type, ...(op.ref ? { ref: op.ref } : {}) });
        } else if (op.op === 'reparent' || op.op === 'reorder') {
          const parent = parentGuard(op.op === 'reparent' ? await api.getNodeByIdAsync(resolve(op.parent)) : node.parent, page); check(); guard(node,page);
          for (let n: BaseNode | null = parent; n; n = n.parent) if (n.id === node.id) fail('PARENT_CYCLE');
          const at = op.index ?? parent.children.length; if (at > parent.children.length) fail('INDEX_OUT_OF_RANGE');
          backup(node); parent.insertChild(at, node);
        } else { backup(node); node.remove(); }
      }
      completed.push(index);
    } catch (e) { failed = { index, code: 'EDIT_FAILED', message: (e instanceof Error ? e.message : 'EDIT_FAILED').slice(0,512) }; break; }
  }
  if (completed.length || backups.length) api.commitUndo();
  return { context: context(), complete: !failed, created, refs, completed, backups, ...(failed ? { failed } : {}), skipped: batch.operations.map((_,i) => i).filter(i => !completed.includes(i) && i !== failed?.index) };
}
