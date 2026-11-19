import { createConnectorTools, isManagedConnector } from './canvas-connectors';
import {
  assertTableSize, CanvasSize, MAX_SLIDES, nextSlideNumber, parseTableText, sameAspect, scaleForExport,
  planSlideFrames, presentationName, resizeTracks, type CanvasCommand, type CanvasResponse, type CanvasSelection,
} from './canvas-tools-model';
import { exportSlide } from './canvas-pptx-layout';
import { MIN_COLUMN, MIN_ROW, resizeTable, tableInfo, updateTable } from './canvas-table-layout';

type CanvasApi = Pick<PluginAPI,'currentPage'|'root'|'viewport'|'createFrame'|'createText'|'createVector'|'getNodeByIdAsync'|'loadFontAsync'|'commitUndo'>;
const MAX_SLIDE_BYTES=24*1024*1024;
export const MAX_PRESENTATION_BYTES=96*1024*1024;
const font:FontName={family:'Inter',style:'Regular'};
const bold:FontName={family:'Inter',style:'Bold'};
const solid=(r:number,g:number,b:number):SolidPaint=>({type:'SOLID',color:{r,g,b}});

function isFrame(node:SceneNode):node is FrameNode {return node.type==='FRAME';}

function checkPage(api:CanvasApi,page:PageNode){
  if(api.currentPage!==page) throw Error('当前页面已切换，请重新操作。');
}

function frameIsLocked(frame:FrameNode){
  for(let node:BaseNode|null=frame;node&&node.type!=='PAGE';node=node.parent){
    if(node.type==='INSTANCE'||('locked' in node&&node.locked)) return true;
  }
  return false;
}

function createSlides(api:CanvasApi,page:PageNode,selection:readonly SceneNode[],p:Extract<CanvasCommand,{type:'canvas-slides'}>){
  const {count,template:useTemplate}=p;
  const template=useTemplate&&selection.length===1&&isFrame(selection[0])?selection[0]:undefined;
  if(useTemplate&&(!template||template.parent!==page||frameIsLocked(template)||Math.abs(template.rotation)>0.01))
    throw Error('复制时请选择一个未旋转、未锁定的顶层画板。');
  const size=CanvasSize.parse(template?{width:Math.round(template.width),height:Math.round(template.height)}:p.size??{width:1920,height:1080});
  const center=api.viewport.center;
  const boxes=page.children.map(node=>node.absoluteBoundingBox).filter((box):box is Rect=>!!box);
  const left=template?template.x+template.width+120:center.x-size.width/2;
  const top=template?template.y:center.y-size.height/2;
  const frames=page.children.filter(isFrame);
  const first=nextSlideNumber(frames.map(frame=>frame.name));
  const initial=planSlideFrames(count,{x:left,y:top},first,size);
  const overlaps=initial.some(frame=>boxes.some(box=>(
    overlapsAxis(frame.x,frame.width,box.x,box.width)&&overlapsAxis(frame.y,frame.height,box.y,box.height)
  )));
  const start=overlaps?boxes.reduce((edge,box)=>Math.max(edge,box.x+box.width+120),left):left;
  const created:FrameNode[]=[];
  try{
    for(const slide of planSlideFrames(count,{x:start,y:top},first,size)){
      const frame=template?template.clone():api.createFrame();
      created.push(frame);
      if(!template) {frame.resize(slide.width,slide.height);frame.clipsContent=true;}
      frame.name=slide.name;
      frame.x=slide.x;frame.y=slide.y;
    }
    page.selection=created;
    api.viewport.scrollAndZoomIntoView(created);
    api.commitUndo();
  }catch(error){for(const frame of created) frame.remove();throw error;}
}

function overlapsAxis(a:number,aSize:number,b:number,bSize:number){return a<b+bSize+24&&b<a+aSize+24;}

async function createTable(api:CanvasApi,page:PageNode,selection:readonly SceneNode[],p:Extract<CanvasCommand,{type:'canvas-table'}>){
  const source=p.text.length?parseTableText(p.text):undefined;
  const rows=source?.length??p.rows,columns=source?.[0].length??p.columns;
  assertTableSize(rows,columns);
  const parent=selection.length===1&&isFrame(selection[0])?selection[0]:undefined;
  if(selection.length&&!parent) throw Error('请选择一个画板，或取消选择后将表格插到画布。');
  if(parent&&frameIsLocked(parent)) throw Error('所选画板被锁定或位于组件实例内。');
  await Promise.all([api.loadFontAsync(font),...(p.header?[api.loadFontAsync(bold)]:[])]);
  checkPage(api,page);
  if(parent&&(parent.removed||frameIsLocked(parent))) throw Error('所选画板已移除或锁定。');

  const uniform=Math.min(160,Math.max(MIN_COLUMN,Math.floor(((parent?.width??1120)-64)/columns)));
  const widths=p.columnWidths??resizeTracks(Array<number>(columns).fill(1),p.width??uniform*columns,MIN_COLUMN);
  if(widths.length!==columns||widths.some(value=>value<MIN_COLUMN)||widths.reduce((sum,size)=>sum+size,0)>7680)
    throw Error('请检查列宽和表格总宽。');
  if(p.rowHeights&&(p.rowHeights.length!==rows||p.rowHeights.some(value=>value<MIN_ROW)))
    throw Error('请检查每一行的高度。');
  if(parent&&widths.reduce((sum,width)=>sum+width,0)>parent.width) throw Error('表格宽度超过所选画板。');
  const grid=api.createFrame();
  const unattached=new Set<SceneNode>();
  try{
    grid.name='FigNexus 表格';
    grid.layoutMode='GRID';
    grid.gridAutoTracks='NONE';
    grid.gridItemsPositioning='ROW_AUTO_FLOW';
    grid.gridColumnCount=columns;
    grid.gridRowCount=rows;
    grid.gridColumnGap=0;
    grid.gridRowGap=0;
    for(const [index,track] of grid.gridColumnSizes.entries()){track.type='FIXED';track.value=widths[index];}
    grid.fills=[];
    grid.clipsContent=false;

    const heights=Array<number>(rows).fill(42);
    const cells:FrameNode[]=[];
    for(let r=0;r<rows;r++){
      for(let c=0;c<columns;c++){
        const cell=api.createFrame();
        unattached.add(cell);
        cell.name='单元格 '+(r+1)+','+(c+1);
        const width=widths[c];
        cell.resize(width,42);
        cell.fills=[];
        const text=api.createText();
        unattached.add(text);
        text.fontName=p.header&&r===0?bold:font;
        text.fontSize=16;
        text.fills=[solid(0.12,0.16,0.23)];
        text.characters=source?.[r][c]??'';
        if(r>0||!p.header) text.textAlignHorizontal=/^\s*[+-]?\d[\d,.]*(?:\s*%)?\s*$/.test(text.characters)?'RIGHT':'LEFT';
        text.resize(width-16,20);
        text.textAutoResize='HEIGHT';
        text.x=12;text.y=10;
        cell.appendChild(text);
        unattached.delete(text);
        grid.appendChild(cell);
        unattached.delete(cell);
        heights[r]=Math.max(heights[r],Math.ceil(text.height)+12);
        cells.push(cell);
      }
    }
    const rowHeights=p.rowHeights??(p.height?resizeTracks(heights,p.height,MIN_ROW):heights);
    if(rowHeights.reduce((sum,value)=>sum+value,0)>7680) throw Error('表格的总高不能超过 7680 px。');
    resizeTable(grid,cells,widths,rowHeights,p.fill??null);
    if(parent){
      parent.appendChild(grid);
      if(parent.layoutMode==='NONE'){grid.x=32;grid.y=32;}
    }else{
      grid.x=Math.round(api.viewport.center.x-grid.width/2);
      grid.y=Math.round(api.viewport.center.y-grid.height/2);
    }
    page.selection=[grid];
    api.viewport.scrollAndZoomIntoView([grid]);
    api.commitUndo();
    return rows+' 行 × '+columns+' 列';
  }catch(error){
    for(const node of unattached) node.remove();
    grid.remove();
    throw error;
  }
}

function isRotated(node:FrameNode) {
  return Math.abs(node.rotation)>0.01||!!node.absoluteTransform&&Math.abs(node.absoluteTransform[0][1])>0.001;
}

async function exportSlides(api:CanvasApi,page:PageNode,frames:FrameNode[],p:Extract<CanvasCommand,{type:'canvas-export'}>,
  size:CanvasSize,post:(response:CanvasResponse)=>void,stillActive:()=>boolean){
  let totalBytes=0;
  for(const [index,frame] of frames.entries()){
    if(!stillActive()) return;
    checkPage(api,page);
    if(frame.removed||isRotated(frame)||!sameAspect(frame,size)) throw Error('画板已删除、旋转或尺寸比例改变，请重新选择。');
    let slideBytes=0;
    const scale=scaleForExport(frame.width,frame.height,p.quality??'high');
    const slide=await exportSlide(frame,p.mode??'image',scale,bytes=>{
      slideBytes+=bytes.length;
      totalBytes+=bytes.length;
      if(slideBytes>MAX_SLIDE_BYTES||totalBytes>MAX_PRESENTATION_BYTES) throw Error('文件较大，请降低清晰度或分批导出。');
    },stillActive);
    if(!stillActive()) return;
    checkPage(api,page);
    post({type:'canvas-progress',id:p.id,done:index+1,total:frames.length,slide});
  }
  return presentationName(p.title?.trim()||api.root.name);
}

export function createCanvasTools(api:CanvasApi,post:(response:CanvasResponse|CanvasSelection)=>void) {
  const connectors=createConnectorTools(api);
  function selection() {
    const {id:pageId,selection:nodes}=api.currentPage;
    if(!nodes) return;
    const table=nodes.length===1?tableInfo(nodes[0]):undefined;
    post({type:'canvas-selection',pageId,count:nodes.length,connector:nodes.length===1&&isManagedConnector(nodes[0]),
      table:table?{id:table.grid.id,width:table.grid.width,height:table.grid.height,columns:table.columns,rows:table.rows,fill:table.fill}:undefined,
      frames:nodes.filter(isFrame).slice(0,MAX_SLIDES).map(node=>({
        id:node.id,name:node.name,x:node.x,y:node.y,width:node.width,height:node.height,rotated:isRotated(node),
      })),
    });
  }
  function prepare(command:CanvasCommand,stillActive=()=>true) {
    const page=api.currentPage;
    const nodes=[...(page.selection??[])];
    return async ()=>{
      try{
        if(command.pageId!==page.id) throw Error('当前页面已切换，请重新操作。');
        checkPage(api,page);
        switch(command.type){
          case 'canvas-slides':
            createSlides(api,page,nodes,command);
            post({type:'canvas-done',id:command.id,message:'已新建 '+command.count+' 张画板。'});
            break;
          case 'canvas-table': {
            const size=await createTable(api,page,nodes,command);
            post({type:'canvas-done',id:command.id,message:'已插入 '+size+' 表格。'});
            break;
          }
          case 'canvas-table-update': {
            if(nodes.length!==1||!isFrame(nodes[0])||nodes[0].removed||frameIsLocked(nodes[0]))
              throw Error('请选择未锁定的 FigNexus 表格。');
            updateTable(nodes[0],command);
            api.commitUndo();
            post({type:'canvas-done',id:command.id,message:'已更新表格尺寸和样式。'});
            break;
          }
          case 'canvas-connect':
            connectors.place(page,nodes,command.kind,command.reverse);
            post({type:'canvas-done',id:command.id,message:'已连接选中的两个图层。'});
            break;
          case 'canvas-reverse':
            await connectors.reverse(page,nodes);
            post({type:'canvas-done',id:command.id,message:'已反转箭头方向。'});
            break;
          case 'canvas-export': {
            const frames=new Map(nodes.filter(isFrame).map(frame=>[frame.id,frame]));
            if(nodes.length!==frames.size||frames.size!==command.frameIds.length||
              new Set(command.frameIds).size!==frames.size||command.frameIds.some(id=>!frames.has(id)))
              throw Error('所选画板已改变，请重新选择。');
            const ordered=command.frameIds.map(id=>frames.get(id)!);
            const size=CanvasSize.parse({width:Math.round(ordered[0].width),height:Math.round(ordered[0].height)});
            if(ordered.some(frame=>isRotated(frame)||!sameAspect(frame,size)))
              throw Error('请选择比例一致且未旋转的画板。');
            const fileName=await exportSlides(api,page,ordered,command,size,post,stillActive);
            if(fileName) post({type:'canvas-done',id:command.id,message:'已渲染所选画板。',fileName,size});
            break;
          }
        }
      }catch(error){if(stillActive()) post({type:'canvas-error',id:command.id,message:error instanceof Error?error.message.slice(0,200):'操作未完成。'});}
      selection();
    };
  }
  return {prepare,selection,refresh:connectors.refresh};
}
