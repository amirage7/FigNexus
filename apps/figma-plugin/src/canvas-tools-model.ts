import { z } from 'zod';

export const MAX_SLIDES = 30;
export const MAX_TABLE_ROWS = 30;
export const MAX_TABLE_COLUMNS = 24;
export const MAX_TABLE_CELLS = 240;
export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;
const id = z.string().min(1).max(128);
const base = { id: id, pageId: id };
const pixels=z.number().int().min(64).max(7680);
export const CanvasSize=z.object({width:pixels,height:pixels}).strict();
export type CanvasSize=z.infer<typeof CanvasSize>;
export const qualities={standard:1280,high:1920,ultra:3840} as const;
export type ExportQuality=keyof typeof qualities;
const track=z.number().finite().min(1).max(7680);
const fill=z.string().regex(/^#[a-fA-F\d]{6}$/).nullable();
const tableOptions={
  width:z.number().int().min(32).max(7680).optional(),height:z.number().int().min(24).max(7680).optional(),fill:fill.optional(),
  columnWidths:z.array(track).max(MAX_TABLE_COLUMNS).optional(),rowHeights:z.array(track).max(MAX_TABLE_ROWS).optional(),
};
export const SlidePresets=[
  {id:'wide',label:'宽屏 16:9',width:1920,height:1080},
  {id:'classic',label:'标准 4:3',width:1600,height:1200},
  {id:'portrait',label:'竖屏 9:16',width:1080,height:1920},
  {id:'square',label:'正方形 1:1',width:1080,height:1080},
  {id:'a4',label:'A4 竖版',width:2480,height:3508},
] as const;

export const CanvasCommand = z.discriminatedUnion('type', [
  z.object({type:z.literal('canvas-slides'), ...base, count:z.number().int().min(1).max(MAX_SLIDES), template:z.boolean(),size:CanvasSize.optional()}).strict(),
  z.object({type:z.literal('canvas-table'), ...base, rows:z.number().int().min(1).max(MAX_TABLE_ROWS), columns:z.number().int().min(1).max(MAX_TABLE_COLUMNS), text:z.string().max(80_000), header:z.boolean(),...tableOptions}).strict(),
  z.object({type:z.literal('canvas-table-update'), ...base, tableId:id,...tableOptions}).strict(),
  z.object({type:z.literal('canvas-connect'), ...base, kind:z.enum(['elbow','straight']), reverse:z.boolean()}).strict(),
  z.object({type:z.literal('canvas-reverse'), ...base}).strict(),
  z.object({type:z.literal('canvas-export'), ...base, frameIds:z.array(id).min(1).max(MAX_SLIDES),title:z.string().max(120).optional(),quality:z.enum(['standard','high','ultra']).optional(),mode:z.enum(['image','editable']).optional()}).strict(),
]);
export type CanvasCommand = z.infer<typeof CanvasCommand>;
export const CanvasSelection = z.object({
  type:z.literal('canvas-selection'), pageId:id, count:z.number().int().nonnegative(), connector:z.boolean(),
  frames:z.array(z.object({id, name:z.string(), x:z.number(), y:z.number(), width:z.number(),height:z.number(),rotated:z.boolean()})).max(MAX_SLIDES),
  table:z.object({id,width:track,height:track,columns:z.array(track),rows:z.array(track),fill}).optional(),
});
export type CanvasSelection = z.infer<typeof CanvasSelection>;
const position={x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()};
const color=z.string().regex(/^[a-fA-F\d]{6}$/);
const item=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('image'),...position,bytes:z.custom<Uint8Array>(value=>value instanceof Uint8Array)}),
  z.object({kind:z.literal('svg'),...position,bytes:z.custom<Uint8Array>(value=>value instanceof Uint8Array)}),
  z.object({kind:z.literal('line'),x:z.number(),y:z.number(),x2:z.number(),y2:z.number(),stroke:color,strokeWidth:z.number().positive()}),
  z.object({kind:z.literal('shape'),...position,shape:z.enum(['rect','ellipse']),fill:color.optional(),stroke:color.optional(),strokeWidth:z.number().optional()}),
  z.object({kind:z.literal('text'),...position,text:z.string(),font:z.string(),fontSize:z.number().positive(),color,bold:z.boolean(),italic:z.boolean(),align:z.enum(['left','center','right','justify']),valign:z.enum(['top','middle','bottom']),wrap:z.boolean().optional()}),
  z.object({kind:z.literal('table'),...position,rows:z.array(z.array(z.object({text:z.string(),fill:color.optional(),color:color.optional(),bold:z.boolean(),align:z.enum(['left','right','center']),fontSize:z.number().optional()}))),columnWidths:z.array(z.number()),rowHeights:z.array(z.number())}),
]);
export type SlideItem=z.infer<typeof item>;
export const SlidePage=z.object({items:z.array(item).max(300),width:z.number().positive().optional(),height:z.number().positive().optional()});
export type SlidePage=z.infer<typeof SlidePage>;
export const CanvasResponse=z.discriminatedUnion('type',[
  z.object({type:z.literal('canvas-progress'),id,done:z.number().int().min(1).max(MAX_SLIDES),total:z.number().int().min(1).max(MAX_SLIDES),slide:SlidePage}),
  z.object({type:z.literal('canvas-done'),id,message:z.string().max(250),fileName:z.string().max(110).optional(),size:CanvasSize.optional()}),
  z.object({type:z.literal('canvas-error'),id,message:z.string().max(250)}),
]);
export type CanvasResponse=z.infer<typeof CanvasResponse>;

export function sameAspect(a:CanvasSize,b:CanvasSize){
  return a.width>0&&a.height>0&&b.width>0&&b.height>0&&Math.abs(a.width/a.height-b.width/b.height)<=0.001;
}

export function scaleForExport(width:number,height:number,quality:ExportQuality){
  return qualities[quality]/Math.max(width,height);
}

export function resizeTracks(tracks:readonly number[],total:number,minimum:number):number[]{
  if(!tracks.length||!Number.isFinite(total)||total<minimum*tracks.length)
    throw Error('整体尺寸过小，请增大尺寸或减少行列。');
  const sizes=Array<number>(tracks.length).fill(minimum);
  let remaining=total;
  let active=tracks.map((_,index)=>index);
  while(active.length){
    const weight=active.reduce((sum,index)=>sum+tracks[index],0);
    const fixed=active.filter(index=>remaining*tracks[index]/weight<minimum);
    if(!fixed.length){
      for(const index of active) sizes[index]=Math.round(remaining*tracks[index]/weight*100)/100;
      const last=active[active.length-1];
      sizes[last]+=total-sizes.reduce((sum,size)=>sum+size,0);
      break;
    }
    remaining-=fixed.length*minimum;
    active=active.filter(index=>!fixed.includes(index));
  }
  return sizes;
}

function slideNumber(name: string) {
  return Number(name.trim().match(/^(\d{1,6})(?=\D|$)/)?.[1] ?? Infinity);
}

export function orderSlideFrames<T extends {name:string;x:number;y:number}>(frames: readonly T[]): T[] {
  return [...frames].sort((a,b)=> (slideNumber(a.name)-slideNumber(b.name)) || a.y-b.y || a.x-b.x);
}

export function nextSlideNumber(names: readonly string[]) {
  return names.reduce((next,name)=>{
    const number = slideNumber(name);
    return Number.isFinite(number) ? Math.max(next,number+1) : next;
  },1);
}

export function planSlideFrames(count:number, start:{x:number;y:number}, first:number,{width,height}:CanvasSize={width:SLIDE_WIDTH,height:SLIDE_HEIGHT}) {
  const columns = Math.min(count,4);
  return Array.from({length:count},(_,index)=>({
    name:String(first+index).padStart(2,'0')+' 幻灯片',
    width,height,
    x:Math.round(start.x)+(index%columns)*(width+120),
    y:Math.round(start.y)+Math.floor(index/columns)*(height+120),
  }));
}

export function assertTableSize(rows:number, columns:number) {
  if(rows>MAX_TABLE_ROWS || columns>MAX_TABLE_COLUMNS || rows*columns>MAX_TABLE_CELLS)
    throw Error('表格最多 '+MAX_TABLE_ROWS+' 行、'+MAX_TABLE_COLUMNS+' 列，且不能超过 '+MAX_TABLE_CELLS+' 格。');
}

function tableDelimiter(text:string) {
  let quoted=false;
  for(let index=0;index<text.length;index++){
    if(text[index]==='"') quoted=!quoted;
    else if(text[index]==='\t'&&!quoted) return '\t';
  }
  return ',';
}

function markdownTable(text:string) {
  const lines=text.split('\n');
  if(lines.length<2||lines.some(line=>!line.trim().startsWith('|')||!line.trim().endsWith('|'))) return;
  const rows=lines.map(line=>{
    const body=line.trim().slice(1,-1);
    const cells:string[]=[];
    let value='';
    for(let index=0;index<body.length;index++){
      if(body[index]==='\\'&&body[index+1]==='|'){value+='|';index++;}
      else if(body[index]==='|'){cells.push(value.trim());value='';}
      else value+=body[index];
    }
    return [...cells,value.trim()];
  });
  if(!rows[1].every(cell=>/^:?-{3,}:?$/.test(cell))) return;
  rows.splice(1,1);
  return normalizeTable(rows);
}

function normalizeTable(rows:string[][]) {
  const columns=Math.max(...rows.map(row=>row.length));
  assertTableSize(rows.length,columns);
  if(rows.some(row=>row.some(cell=>cell.length>1500))) throw Error('单个单元格最多 1500 个字符。');
  return rows.map(row=>[...row,...Array<string>(columns-row.length).fill('')]);
}

export function parseTableText(source:string): string[][] {
  if(source.length>80_000) throw Error('粘贴的表格内容太长。');
  const text=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\n$/,'');
  const markdown=markdownTable(text);
  if(markdown) return markdown;
  const separator=tableDelimiter(text);
  const rows:string[][]=[[]];
  let field='', quoted=false, closed=false, started=false;
  const push=()=>{
    if(field.length>1500) throw Error('单个单元格最多 1500 个字符。');
    const row=rows[rows.length-1];
    row.push(field);
    if(row.length>MAX_TABLE_COLUMNS) assertTableSize(rows.length,row.length);
    field=''; closed=false; started=false;
  };
  for(let index=0;index<text.length;index++){
    const ch=text[index];
    if(quoted){
      if(ch!=='"') field+=ch;
      else if(text[index+1]==='"'){field+='"';index++;}
      else {quoted=false;closed=true;}
    }else if(ch===separator||ch==='\n'){
      push();
      if(ch==='\n'){rows.push([]);if(rows.length>MAX_TABLE_ROWS) assertTableSize(rows.length,1);}
    }else if(closed){
      throw Error('引号后的表格分隔符无效。');
    }else if(ch==='"'&&!started){
      quoted=true;started=true;
    }else{
      field+=ch;started=true;
    }
  }
  if(quoted) throw Error('表格里有未闭合的引号。');
  push();
  return normalizeTable(rows);
}

export function presentationName(title:string) {
  const safe=title.trim().replace(/\.pptx$/i,'').replace(/[<>:"/\\|?*\u0000-\u001F]/g,'_').slice(0,96).trim().replace(/[. ]+$/,'');
  const name=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)?'_'+safe:safe;
  return (name||'FigNexus')+'.pptx';
}
