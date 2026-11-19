import { assertTableSize, resizeTracks, type CanvasCommand } from './canvas-tools-model';

export const MIN_COLUMN=32;
export const MIN_ROW=24;
const border:SolidPaint={type:'SOLID',color:{r:0.19,g:0.19,b:0.19}};
const tableKey='fig-nexus-table-v1';

export function paintColor(paints:readonly Paint[]|symbol|undefined) {
  if(!Array.isArray(paints)) return;
  const visible=(paints as readonly Paint[]).filter(paint=>paint.visible!==false&&(paint.opacity??1)>0);
  if(visible.length!==1||visible[0].type!=='SOLID'||(visible[0].opacity??1)!==1) return;
  const {r,g,b}=visible[0].color;
  return [r,g,b].map(value=>Math.round(value*255).toString(16).padStart(2,'0')).join('').toUpperCase();
}

function fromHex(hex:string):SolidPaint {
  const value=Number.parseInt(hex.slice(1),16);
  return {type:'SOLID',color:{r:(value>>16)/255,g:((value>>8)&255)/255,b:(value&255)/255}};
}

export function tableInfo(node:SceneNode) {
  if(node.type!=='FRAME'||node.layoutMode!=='GRID') return;
  const rowCount=node.gridRowCount,columnCount=node.gridColumnCount;
  if(!rowCount||!columnCount||node.children.length!==rowCount*columnCount||node.children.length>240) return;
  let known=node.name.startsWith('FigNexus 表格')||node.children.every(cell=>/^单元格 \d+,\d+$/.test(cell.name));
  if(!known){try{known=node.getPluginData(tableKey)==='1';}catch{/* A development manifest can lack private storage. */}}
  if(!known) return;
  const children=node.children;
  if(!children.every((cell):cell is FrameNode=>cell.type==='FRAME'&&cell.children.length===1&&cell.children[0].type==='TEXT')) return;
  let cells=children;
  if(node.gridItemsPositioning==='MANUAL'){
    const byIndex=new Map(cells.map(cell=>[cell.gridRowAnchorIndex*columnCount+cell.gridColumnAnchorIndex,cell]));
    if(byIndex.size!==cells.length||cells.some(cell=>cell.gridRowSpan!==1||cell.gridColumnSpan!==1)) return;
    const ordered=Array.from({length:cells.length},(_,index)=>byIndex.get(index));
    if(!ordered.every((cell):cell is FrameNode=>!!cell)) return;
    cells=ordered;
  }
  const dimension=(track:GridTrackSize|undefined,actual:number)=>track?.type==='FIXED'?(track.value??actual):actual;
  const columns=Array.from({length:columnCount},(_,index)=>dimension(node.gridColumnSizes[index],cells[index].width));
  const rows=Array.from({length:rowCount},(_,index)=>dimension(node.gridRowSizes[index],cells[index*columnCount].height));
  const first=paintColor(cells[0].fills);
  const fill=first&&cells.every(cell=>paintColor(cell.fills)===first)?'#'+first:null;
  return {grid:node,cells,columns,rows,fill};
}

export function resizeTable(grid:FrameNode,cells:readonly FrameNode[],columns:readonly number[],rows:readonly number[],fill:string|null) {
  grid.gridColumnGap=0;
  grid.gridRowGap=0;
  grid.fills=[];
  grid.strokes=[border];
  grid.strokeWeight=1;
  grid.strokeAlign='INSIDE';
  const columnTracks=grid.gridColumnSizes,rowTracks=grid.gridRowSizes;
  columns.forEach((size,index)=>{columnTracks[index].type='FIXED';columnTracks[index].value=size;});
  rows.forEach((size,index)=>{rowTracks[index].type='FIXED';rowTracks[index].value=size;});
  const paints=fill?[fromHex(fill)]:[];
  cells.forEach((cell,index)=>{
    const row=Math.floor(index/columns.length),column=index%columns.length;
    cell.resize(columns[column],rows[row]);
    cell.clipsContent=true;
    cell.fills=paints;
    cell.strokes=[border];
    cell.strokeAlign='INSIDE';
    cell.strokeTopWeight=0;
    cell.strokeLeftWeight=0;
    cell.strokeRightWeight=column+1<columns.length?1:0;
    cell.strokeBottomWeight=row+1<rows.length?1:0;
    const text=cell.children[0];
    if(text.type==='TEXT'){
      text.textAutoResize='NONE';
      text.resize(Math.max(8,columns[column]-16),Math.max(8,rows[row]-12));
      text.textAlignVertical='CENTER';
      text.x=8;text.y=6;
    }
  });
  grid.resize(columns.reduce((sum,size)=>sum+size,0),rows.reduce((sum,size)=>sum+size,0));
  try{grid.setPluginData(tableKey,'1');}catch{/* The grid structure also identifies development tables. */}
}

export function updateTable(node:SceneNode,p:Extract<CanvasCommand,{type:'canvas-table-update'}>) {
  const info=tableInfo(node);
  if(!info||info.grid.id!==p.tableId) throw Error('请选择要调整的 FigNexus 表格。');
  assertTableSize(info.rows.length,info.columns.length);
  const plan=(current:number[],explicit:readonly number[]|undefined,target:number|undefined,minimum:number)=>{
    if(explicit){
      if(explicit.length!==current.length||explicit.some(value=>value<minimum))
        throw Error('行列尺寸与表格不匹配，或有尺寸低于允许的最小值。');
      return explicit;
    }
    return target?resizeTracks(current,target,minimum):current;
  };
  const columns=plan(info.columns,p.columnWidths,p.width,MIN_COLUMN);
  const rows=plan(info.rows,p.rowHeights,p.height,MIN_ROW);
  if(columns.reduce((sum,value)=>sum+value,0)>7680||rows.reduce((sum,value)=>sum+value,0)>7680)
    throw Error('表格的总宽和总高不能超过 7680 px。');
  resizeTable(info.grid,info.cells,columns,rows,p.fill===undefined?info.fill:p.fill);
}
