import { z } from 'zod';

type Point = {x:number; y:number};
type Bounds = Point & {width:number; height:number};
type Kind = 'elbow' | 'straight';
const key = 'fig-nexus-connector-v1';
const Link = z.object({from:z.string().min(1).max(128),to:z.string().min(1).max(128),kind:z.enum(['elbow','straight'])}).strict();
type Link = z.infer<typeof Link>;
const maxConnectors = 100;

export function connectorPath(from:Bounds,to:Bounds,kind:Kind) {
  const a={x:from.x+from.width/2,y:from.y+from.height/2};
  const b={x:to.x+to.width/2,y:to.y+to.height/2};
  const dx=b.x-a.x,dy=b.y-a.y;
  const horizontal=Math.abs(dx)>=Math.abs(dy);
  const fromScale=1/Math.max(Math.abs(dx)/Math.max(from.width/2,1),Math.abs(dy)/Math.max(from.height/2,1),1e-8);
  const toScale=1/Math.max(Math.abs(dx)/Math.max(to.width/2,1),Math.abs(dy)/Math.max(to.height/2,1),1e-8);
  const sign=Math.sign(horizontal?dx:dy)||1;
  const start=kind==='straight'?{x:a.x+dx*fromScale,y:a.y+dy*fromScale}:horizontal
    ?{x:a.x+sign*from.width/2,y:a.y}:{x:a.x,y:a.y+sign*from.height/2};
  const end=kind==='straight'?{x:b.x-dx*toScale,y:b.y-dy*toScale}:horizontal
    ?{x:b.x-sign*to.width/2,y:b.y}:{x:b.x,y:b.y-sign*to.height/2};
  const middleX=(start.x+end.x)/2,middleY=(start.y+end.y)/2;
  const route=kind==='straight'?[start,end]:horizontal?[start,{x:middleX,y:start.y},{x:middleX,y:end.y},end]:
    [start,{x:start.x,y:middleY},{x:end.x,y:middleY},end];
  const points=route.filter((point,index)=>!index||point.x!==route[index-1].x||point.y!==route[index-1].y);
  const previous=points[points.length-2]??a;
  const length=Math.hypot(end.x-previous.x,end.y-previous.y);
  const ux=length?(end.x-previous.x)/length:(horizontal?sign:0);
  const uy=length?(end.y-previous.y)/length:(horizontal?0:sign);
  const arrowSize=Math.min(12,Math.max(4,length*0.65));
  const back={x:end.x-ux*arrowSize,y:end.y-uy*arrowSize};
  const spread=arrowSize*0.46;
  return {points,arrow:[{x:back.x-uy*spread,y:back.y+ux*spread},end,{x:back.x+uy*spread,y:back.y-ux*spread}]};
}

function inside(node:BaseNode, container:BaseNode):boolean {
  for(let ancestor=node.parent;ancestor;ancestor=ancestor.parent) if(ancestor===container) return true;
  return false;
}

function locked(node:BaseNode):boolean {
  for(let ancestor:BaseNode|null=node;ancestor&&ancestor.type!=='PAGE';ancestor=ancestor.parent){
    if(ancestor.type==='INSTANCE'||('locked' in ancestor&&ancestor.locked)) return true;
  }
  return false;
}

function linkData(node:SceneNode):Link|undefined {
  if(node.type!=='VECTOR') return;
  try{
    const value=Link.safeParse(JSON.parse(node.getPluginData(key)));
    if(value.success&&value.data.from!==value.data.to) return value.data;
  }catch{ /* Ordinary vectors and unreadable metadata are left alone. */ }
}

export function isManagedConnector(node:SceneNode) {
  return !!linkData(node);
}

function commonFrame(page:PageNode,from:SceneNode,to:SceneNode):FrameNode|PageNode {
  for(let node=from.parent;node&&node!==page;node=node.parent){
    if(node.type==='FRAME'&&inside(to,node)) return node;
  }
  return page;
}

function localPoint(point:Point,parent:BaseNode&Partial<LayoutMixin>):Point {
  if(!parent.absoluteTransform) return point;
  const [[a,b,x],[c,d,y]]=parent.absoluteTransform;
  const det=a*d-b*c;
  return {x:(d*(point.x-x)-b*(point.y-y))/det,y:(-c*(point.x-x)+a*(point.y-y))/det};
}

function draw(vector:VectorNode,from:SceneNode,to:SceneNode,signatures:WeakMap<VectorNode,string>,kind:Kind) {
  const a=from.absoluteBoundingBox,b=to.absoluteBoundingBox,parent=vector.parent;
  if(!a||!b||!parent||!inside(from,parent)||!inside(to,parent)) return false;
  const shape=connectorPath(a,b,kind);
  const points=shape.points.map(point=>localPoint(point,parent));
  const arrow=shape.arrow.map(point=>localPoint(point,parent));
  const all=[...points,...arrow];
  const x=Math.min(...all.map(point=>point.x)),y=Math.min(...all.map(point=>point.y));
  if(!Number.isFinite(x)||!Number.isFinite(y)) return false;
  const path=(list:Point[])=>list.map((point,index)=>(index?'L ':'M ')+(point.x-x).toFixed(3)+' '+(point.y-y).toFixed(3)).join(' ');
  const data=path(points)+' '+path(arrow);
  if(signatures.get(vector)!==data){
    vector.vectorPaths=[{windingRule:'NONE',data}];
    signatures.set(vector,data);
  }
  if(Math.abs(vector.x-x)>0.01) vector.x=x;
  if(Math.abs(vector.y-y)>0.01) vector.y=y;
  return true;
}

export function createConnectorTools(api:Pick<PluginAPI,'currentPage'|'createVector'|'getNodeByIdAsync'|'commitUndo'>) {
  const signatures=new WeakMap<VectorNode,string>();
  const find=(page:PageNode)=>page.findAllWithCriteria?.({types:['VECTOR'],pluginData:{keys:[key]}})??[];
  const place=(page:PageNode,selection:readonly SceneNode[],kind:Kind,reverse:boolean)=>{
    if(selection.length!==2) throw Error('请选择两个要连接的图层。');
    const [from,to]=reverse?[selection[1],selection[0]]:selection;
    if(from.removed||to.removed||locked(from)||locked(to)||inside(from,to)||inside(to,from)||
      !inside(from,page)||!inside(to,page)||isManagedConnector(from)||isManagedConnector(to))
      throw Error('请选择当前页面中两个独立且可编辑的图层。');
    if(find(page).length>=maxConnectors) throw Error('当前页面最多支持 100 条 FigNexus 连线。');
    const parent=commonFrame(page,from,to);
    const vector=api.createVector();
    try {
      if(parent!==page){
        parent.appendChild(vector);
        if(parent.type==='FRAME'&&parent.layoutMode!=='NONE') vector.layoutPositioning='ABSOLUTE';
      }
      vector.name='FigNexus 连线';
      vector.fills=[];
      vector.strokes=[{type:'SOLID',color:{r:0.22,g:0.31,b:0.44}}];
      vector.strokeWeight=2;
      vector.strokeCap='ROUND';
      vector.strokeJoin='ROUND';
      try{vector.setPluginData(key,JSON.stringify({from:from.id,to:to.id,kind}));}catch{
        throw Error('无法保存连线端点，请使用带有效 Figma 插件 ID 的 FigNexus。');
      }
      if(!draw(vector,from,to,signatures,kind)) throw Error('无法读取所选图层的位置。');
      page.selection=[vector];
      api.commitUndo();
    } catch(error){vector.remove();throw error;}
  };

  async function endpoints(link:Link) {
    const [from,to]=await Promise.all([api.getNodeByIdAsync(link.from),api.getNodeByIdAsync(link.to)]);
    if(!from||!to||from.removed||to.removed||!('absoluteBoundingBox' in from)||!('absoluteBoundingBox' in to)) return;
    return [from,to] as const;
  }

  async function reverse(page:PageNode,selection:readonly SceneNode[]) {
    const vector=selection[0];
    if(selection.length!==1||vector.type!=='VECTOR'||locked(vector)) throw Error('请选择一条可编辑的 FigNexus 连线。');
    const link=linkData(vector);
    if(!link) throw Error('请选择一条 FigNexus 连线。');
    const target=await endpoints(link);
    if(api.currentPage!==page||vector.removed||!inside(vector,page)||locked(vector)||!target||!draw(vector,target[1],target[0],signatures,link.kind))
      throw Error('连线端点已删除、移动到其他画板，或当前页面已切换。');
    vector.setPluginData(key,JSON.stringify({...link,from:link.to,to:link.from}));
    api.commitUndo();
  }

  async function refresh(page:PageNode) {
    if(!page.findAllWithCriteria) return;
    for(const vector of find(page).slice(0,maxConnectors)){
      try {
        const link=linkData(vector);
        if(!link||locked(vector)) continue;
        const nodes=await endpoints(link);
        if(api.currentPage!==page) return;
        if(nodes&&!vector.removed&&!locked(vector)) draw(vector,nodes[0],nodes[1],signatures,link.kind);
      }catch{ /* An invalid connector must not stop other lines from updating. */ }
    }
  }
  return {place,reverse,refresh};
}
