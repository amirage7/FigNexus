import { vi } from 'vitest';
export function fixture() {
  let seq = 0;
  const nodes = new Map<string, any>();
  const page: any = { id: 'p', name: 'Page', type: 'PAGE', children: [], selection: [], parent: null };
  const append = (parent: any, n: any, index = parent.children.length) => { if(n.parent) n.parent.children = n.parent.children.filter((v: any) => v !== n); parent.children.splice(Math.min(index,parent.children.length),0,n); n.parent = parent; };
  page.appendChild = (n: any) => append(page,n); page.insertChild = (i: number,n: any) => append(page,n,i); nodes.set('p',page);
  function make(type: string): any {
    const data=new Map<string,string>();
    const n: any = { id: `n${++seq}`, type, name: type, parent: null, x: 0, y: 0, width: 100, height: 100, locked: false, visible: true, removed: false, characters: '', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16, fills: [],
      getPluginData:(key:string)=>data.get(key)??'',setPluginData:(key:string,value:string)=>{data.set(key,value);},getPluginDataKeys:()=>[...data.keys()],
      resize(w: number,h: number) { n.width=w; n.height=h; }, resizeWithoutConstraints(w: number,h: number) { n.width=w; n.height=h; }, remove() { for(const child of [...(n.children??[])])child.remove(); n.parent.children=n.parent.children.filter((v: any)=>v!==n); n.removed=true; nodes.delete(n.id); }, getRangeAllFontNames: () => [{family:'Inter',style:'Regular'},{family:'Inter',style:'Bold'}],
      clone() { const copy=make(type); for(const key of ['name','x','y','width','height','characters','fontName','fills','vectorPaths','strokes','strokeWeight','strokeCap','strokeJoin','rotation']) copy[key]=n[key]; for(const [key,value] of data)copy.setPluginData(key,value); if(n.children) for(const child of [...n.children]) copy.appendChild(child.clone()); return copy; } };
    if(type === 'FRAME') { n.children=[]; n.layoutMode='NONE'; n.appendChild=(child: any)=>append(n,child); n.insertChild=(i: number,child: any)=>append(n,child,i); }
    page.appendChild(n); nodes.set(n.id,n); return n;
  }
  const api: any = { root:{id:'0',name:'Test',children:[page]}, currentPage:page, getNodeByIdAsync:async(id: string)=>nodes.get(id)??null, createFrame:()=>make('FRAME'), createText:()=>make('TEXT'),createRectangle:()=>make('RECTANGLE'),createEllipse:()=>make('ELLIPSE'),loadFontAsync:vi.fn(async()=>{}),commitUndo:vi.fn() };
  return {api,page,nodes,make};
}

