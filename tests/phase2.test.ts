import { describe, it, expect, vi } from 'vitest';
import { Creation, ReadInput } from '../packages/protocol/src/index';
import { createExecutor } from '../apps/figma-plugin/src/executor';

describe('Phase 2 schemas', () => {
  it('rejects arbitrary code, unbounded reads and malformed creation', () => {
    expect(ReadInput.safeParse({ limit: 1000 }).success).toBe(false);
    expect(Creation.safeParse({ op: 'eval', code: 'figma.root.remove()' }).success).toBe(false);
    expect(Creation.safeParse({ op: 'create', type: 'TEXT', characters: 'x', width: -1 }).success).toBe(false);
  });
});

function fixture() {
  let count = 0;
  const page: any = { id: 'p', name: 'Page', type: 'PAGE', children: [] };
  const nodes = new Map<string, any>([['p', page]]);
  const make = (type: string) => {
    const n: any = { id: `n${++count}`, type, name: type, x: 0, y: 0, width: 100, height: 100, locked: false,
      children: type === 'FRAME' ? [] : undefined, remove: vi.fn(() => { n.parent.children = n.parent.children.filter((v: any) => v !== n); nodes.delete(n.id); }),
      resize: (w: number, h: number) => { n.width = w; n.height = h; },
      appendChild: (child: any) => { if(child.parent) child.parent.children = child.parent.children.filter((v: any) => v !== child); n.children.push(child); child.parent = n; } };
    if (type !== 'FRAME') delete n.children;
    if (type === 'TEXT') n.characters = '';
    page.children.push(n); n.parent = page; nodes.set(n.id, n); return n;
  };
  page.appendChild = (n: any) => { if(n.parent) n.parent.children = n.parent.children.filter((v: any) => v !== n); page.children.push(n); n.parent = page; };
  const api: any = { root: { id: '0', name: 'Test', children: [page] }, currentPage: page,
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null, createFrame: () => make('FRAME'), createText: () => make('TEXT'), createRectangle: () => make('RECTANGLE'), createEllipse: () => make('ELLIPSE'),
    loadFontAsync: vi.fn(async () => {}), commitUndo: vi.fn() };
  return { api, page, nodes, make };
}

describe('Phase 2 executor', () => {
  it('rechecks execution deadline after an asynchronous parent lookup', async () => {
    const f = fixture(); const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const get = f.api.getNodeByIdAsync;
    f.api.getNodeByIdAsync = async (id: string) => { clock.mockReturnValue(20000); return get(id); };
    try {
      const result: any = await createExecutor(f.api, () => true)('execute', { operations: [{ op: 'create', type: 'FRAME', ref: 'root' }, { op: 'create', type: 'TEXT', parent: '$root', characters: 'late' }] });
      expect(result.created).toHaveLength(1); expect(result.failed.message).toBe('EXECUTION_DEADLINE'); expect(f.nodes.size).toBe(2);
    } finally { clock.mockRestore(); }
  });
  it('refuses locked ancestors, cross-page IDs and non-text text attributes', async () => {
    const f = fixture(); const e = createExecutor(f.api, () => true);
    const frame = f.make('FRAME'); frame.locked = true;
    await expect(e('execute', { operations: [{ op: 'create', type: 'TEXT', parent: frame.id }] })).rejects.toThrow('PARENT_NOT_EDITABLE');
    await expect(e('execute', { operations: [{ op: 'create', type: 'RECTANGLE', characters: 'bad' }] })).rejects.toThrow();
    expect(f.page.children).toHaveLength(1);
    const foreign = f.make('FRAME'); foreign.parent = { id: 'other', parent: null };
    const result: any = await e('get_nodes', { ids: [foreign.id, frame.id], fields: ['locked'] });
    expect(result.missing).toEqual([foreign.id]); expect(result.nodes).toHaveLength(1); expect(result.nodes[0].locked).toBe(true);
  });
  it('stops mutations if permission is revoked during font loading', async () => {
    const f = fixture(); let consent = true;
    f.api.loadFontAsync.mockImplementation(async () => { consent = false; });
    const e = createExecutor(f.api, () => consent);
    const result: any = await e('execute', { operations: [{ op: 'create', type: 'TEXT', characters: 'x' }] });
    expect(result.complete).toBe(false); expect(result.failed.message).toBe('WRITE_DISABLED'); expect(f.page.children).toHaveLength(0);
  });
  it('bounds traversal and long text output', async () => {
    const f = fixture(); const text = f.make('TEXT'); text.characters = 'x'.repeat(5000); text.name = 'n'.repeat(3000);
    for (let i = 0; i < 10010; i++) f.make('RECTANGLE');
    const e = createExecutor(f.api, () => false);
    const result: any = await e('find_nodes', { depth: 1, fields: ['name','characters'] });
    expect(result.scanned).toBe(10000); expect(result.truncated).toBe(true); expect(result.nodes[0].characters).toHaveLength(256); expect(result.nodes[0].name).toHaveLength(128);
  });
  it('requires local write permission', async () => {
    const f = fixture(); const e = createExecutor(f.api, () => false);
    await expect(e('execute', { operations: [{ op: 'create', type: 'FRAME' }] })).rejects.toThrow('WRITE_DISABLED');
    expect(f.page.children).toHaveLength(0);
  });
  it('resolves forward refs and returns native IDs in input order', async () => {
    const f = fixture(); const e = createExecutor(f.api, () => true);
    const r: any = await e('execute', { operations: [{ op: 'create', type: 'TEXT', ref: 'title', parent: '$phone', characters: 'Hello' }, { op: 'create', type: 'FRAME', ref: 'phone', width: 390, height: 844 }] });
    expect(r.complete).toBe(true); expect(r.created.map((x: any) => x.index)).toEqual([0,1]);
    expect(f.nodes.get(r.refs.title).parent.id).toBe(r.refs.phone);
    expect(f.api.loadFontAsync).toHaveBeenCalled(); expect(f.nodes.get(r.refs.title).characters).toBe('Hello');
  });
  it('preflights cycles and invalid parents before creating anything', async () => {
    const f = fixture(); const e = createExecutor(f.api, () => true);
    await expect(e('execute', { operations: [{ op: 'create', type: 'FRAME', ref: 'a', parent: '$b' }, { op: 'create', type: 'FRAME', ref: 'b', parent: '$a' }] })).rejects.toThrow('REF_CYCLE');
    expect(f.page.children).toHaveLength(0);
    const rect = f.make('RECTANGLE');
    await expect(e('execute', { operations: [{ op: 'create', type: 'FRAME', parent: rect.id }] })).rejects.toThrow('INVALID_PARENT');
    expect(f.page.children).toHaveLength(1);
  });
  it('font failure reports partial results without leaving an empty text', async () => {
    const f = fixture(); f.api.loadFontAsync.mockRejectedValue(new Error('Unavailable font'));
    const e = createExecutor(f.api, () => true);
    const r: any = await e('execute', { operations: [{ op: 'create', type: 'FRAME', ref: 'root' }, { op: 'create', type: 'TEXT', parent: '$root', characters: 'x' }] });
    expect(r.complete).toBe(false); expect(r.created).toHaveLength(1); expect(f.nodes.size).toBe(2);
  });
  it('returns bounded flat reads with pagination and field selection', async () => {
    const f = fixture(); const frame = f.make('FRAME'); frame.appendChild(f.make('TEXT')); f.make('ELLIPSE');
    const e = createExecutor(f.api, () => false);
    const r: any = await e('get_document', { limit: 1, depth: 1, fields: ['name'] });
    expect(r.nodes).toHaveLength(1); expect(r.nextCursor).toBe(1); expect(r.nodes[0]).toEqual({ id: frame.id, type: 'FRAME', name: 'FRAME' });
    const second: any = await e('get_document', { cursor: 1, limit: 2, depth: 1 });
    expect(second.nodes).toHaveLength(1); expect(second.nodes[0].type).toBe('ELLIPSE');
  });
});
