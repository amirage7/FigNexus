import {paintColor,tableInfo} from './canvas-table-layout';
import {frameSurface,visibleEffects} from './canvas-pptx-frame';
import type {SlideItem,SlidePage} from './canvas-tools-model';

function hasPaint(value:readonly Paint[]|symbol|undefined) {
  return typeof value==='symbol'||(Array.isArray(value)&&value.some(paint=>paint.visible!==false&&(paint.opacity??1)>0));
}

function simpleAppearance(node:SceneNode,allowRotation=false,allowFrameEffects=false) {
  return (!('opacity' in node)||node.opacity===1)&&
    (allowFrameEffects||!('effects' in node)||!node.effects.some(effect=>effect.visible!==false))&&
    (!('blendMode' in node)||node.blendMode==='NORMAL'||node.blendMode==='PASS_THROUGH')&&
    (allowRotation||!node.absoluteTransform||(
      Math.abs(node.absoluteTransform[0][0]-1)<0.001&&Math.abs(node.absoluteTransform[1][1]-1)<0.001&&
      Math.abs(node.absoluteTransform[0][1])<0.001&&Math.abs(node.absoluteTransform[1][0])<0.001
    ));
}

function renderBounds(node:SceneNode){return 'absoluteRenderBounds' in node?node.absoluteRenderBounds:node.absoluteBoundingBox;}

function position(bounds:Rect, origin:Rect){
  return {x:bounds.x-origin.x,y:bounds.y-origin.y,width:bounds.width,height:bounds.height};
}

function within(inner:Rect, outer:Rect){
  const tolerance=0.5;
  return inner.x>=outer.x-tolerance&&inner.y>=outer.y-tolerance&&
    inner.x+inner.width<=outer.x+outer.width+tolerance&&inner.y+inner.height<=outer.y+outer.height+tolerance;
}

function containsSvgImage(bytes:Uint8Array) {
  // Figma places the sources of raster photos in SVG image or pattern elements.
  // Some Office SVG renderers omit those photos, so keep a standalone PNG for that subtree.
  for(let i=bytes.indexOf(60);i>=0&&i+5<bytes.length;i=bytes.indexOf(60,i+1)){
    if(bytes[i+1]===105&&bytes[i+2]===109&&bytes[i+3]===97&&bytes[i+4]===103&&bytes[i+5]===101) return true;
  }
  return false;
}

function nativeText(node:TextNode,bounds:Rect,origin:Rect):SlideItem|undefined {
  const color=paintColor(node.fills);
  if(!color||typeof node.fontName!=='object'||typeof node.fontSize!=='number'||!node.characters||
    hasPaint(node.strokes)||node.textCase!=='ORIGINAL'||
    (node.textDecoration!=='NONE'&&node.textDecoration!==undefined)) return;
  return {kind:'text',...position(bounds,origin),text:node.characters,font:node.fontName.family,fontSize:node.fontSize,color,wrap:node.textAutoResize!=='WIDTH_AND_HEIGHT',
    bold:/bold|heavy|black|semibold/i.test(node.fontName.style),italic:/italic|oblique/i.test(node.fontName.style),
    align:node.textAlignHorizontal==='JUSTIFIED'?'justify':node.textAlignHorizontal==='CENTER'?'center':node.textAlignHorizontal==='RIGHT'?'right':'left',
    valign:node.textAlignVertical==='CENTER'?'middle':node.textAlignVertical==='BOTTOM'?'bottom':'top'};
}

function nativeLine(node:LineNode,origin:Rect):SlideItem|undefined {
  const stroke=paintColor(node.strokes);
  if(!stroke||!simpleAppearance(node,true)||node.dashPattern?.length||
    (node.strokeCap!==undefined&&node.strokeCap!=='NONE')||
    typeof node.strokeWeight!=='number'||node.strokeWeight<=0||node.width<=0) return;
  const transform=node.absoluteTransform;
  if(!transform) return;
  const [[a,,x],[c,,y]]=transform;
  return {kind:'line',x:x-origin.x,y:y-origin.y,x2:x+a*node.width-origin.x,y2:y+c*node.width-origin.y,stroke,strokeWidth:node.strokeWeight};
}

function nativeShape(node:FrameNode|RectangleNode|EllipseNode,bounds:Rect,origin:Rect):SlideItem|null|undefined {
  const fill=paintColor(node.fills),stroke=paintColor(node.strokes);
  if((!fill&&hasPaint(node.fills))||(!stroke&&hasPaint(node.strokes))||(stroke&&(typeof node.strokeWeight!=='number'||node.dashPattern.length))||
    ('cornerRadius' in node&&node.cornerRadius!==0)||(node.type==='ELLIPSE'&&(node.arcData.innerRadius!==0||Math.abs(node.arcData.endingAngle-node.arcData.startingAngle)<6.28)))
    return;
  if(!fill&&!stroke) return null;
  return {kind:'shape',shape:node.type==='ELLIPSE'?'ellipse':'rect',...position(bounds,origin),fill,stroke,
    strokeWidth:stroke&&typeof node.strokeWeight==='number'?node.strokeWeight:undefined};
}

function nativeTable(node:SceneNode,bounds:Rect,origin:Rect):SlideItem|undefined {
  const table=tableInfo(node);
  if(!table||table.grid.gridColumnGap||table.grid.gridRowGap||!table.cells.every(cell=> {
    const text=cell.children[0];
    return text.type==='TEXT'&&typeof text.fontName==='object'&&typeof text.fontSize==='number'&&
      typeof cell.fills!=='symbol'&&!cell.fills.some(paint=>paint.type!=='SOLID');
  })) return;
  const rows=table.rows.map((_,index)=>table.cells.slice(index*table.columns.length,(index+1)*table.columns.length).map(cell=>{
    const text=cell.children[0] as TextNode;
    const style=typeof text.fontName==='object'?text.fontName.style:'';
    return {text:text.characters,fill:paintColor(cell.fills),color:paintColor(text.fills),fontSize:typeof text.fontSize==='number'?text.fontSize:undefined,
      bold:/bold|heavy|black/i.test(style),align:text.textAlignHorizontal==='RIGHT'?'right' as const:text.textAlignHorizontal==='CENTER'?'center' as const:'left' as const};
  }));
  return {kind:'table',...position(bounds,origin),rows,columnWidths:table.columns,rowHeights:table.rows};
}

export async function exportSlide(frame:FrameNode,mode:'image'|'editable',scale:number,consume:(bytes:Uint8Array)=>void,stillActive:()=>boolean):Promise<SlidePage>{
  const origin=frame.absoluteBoundingBox??{x:frame.x,y:frame.y,width:frame.width,height:frame.height};
  const items:SlideItem[]=[];
  const rootBounds={x:0,y:0,width:frame.width,height:frame.height};
  const raster=async(node:SceneNode,bounds:Rect,whole=false)=>{
    if(!stillActive()) throw Error('导出已取消。');
    if(bounds.width<=0||bounds.height<=0) return;
    const safeScale=Math.min(scale,4096/Math.max(bounds.width,bounds.height));
    const bytes=await node.exportAsync({format:'PNG',constraint:{type:'SCALE',value:safeScale},contentsOnly:true,useAbsoluteBounds:whole});
    if(!stillActive()) throw Error('导出已取消。');
    consume(bytes);
    items.push({kind:'image',...bounds,bytes});
  };

  async function fallback(node:SceneNode,bounds:Rect,whole:boolean){
    if(bounds.width<=0||bounds.height<=0) return;
    const rasterOnly='fills' in node&&Array.isArray(node.fills)&&node.fills.some(paint=>paint.type==='IMAGE'||paint.type==='VIDEO');
    if(!rasterOnly){
      let svg:Uint8Array|undefined;
      try{
        const candidate=await node.exportAsync({format:'SVG',contentsOnly:true,useAbsoluteBounds:whole,svgOutlineText:true,svgSimplifyStroke:false});
        if(candidate instanceof Uint8Array&&String.fromCharCode(...candidate.subarray(0,512)).includes('<svg')) svg=candidate;
      }catch{/* Keep this layer through the PNG fallback when SVG export fails. */}
      if(!stillActive()) throw Error('导出已取消。');
      if(svg&&!containsSvgImage(svg)){consume(svg);items.push({kind:'svg',...bounds,bytes:svg});return;}
    }
    await raster(node,bounds,whole);
  }

  let visited=0;
  async function visit(node:SceneNode){
    if(!stillActive()) throw Error('导出已取消。');
    if(!node.visible||('opacity' in node&&node.opacity===0)) return;
    if(++visited>300) throw Error('单个画板的图层较多。请选择图片版导出。');
    const bounds=node.absoluteBoundingBox;
    const whole=node===frame;
    const rendered=renderBounds(node)??bounds;
    const preserve=()=>rendered?fallback(node,whole?rootBounds:position(rendered,origin),whole):Promise.resolve();
    if(node.type==='LINE'){
      const line=nativeLine(node,origin);
      if(line) items.push(line);
      else await preserve();
      return;
    }
    if(!bounds||bounds.width<=0||bounds.height<=0){await preserve();return;}
    if(!simpleAppearance(node,false,node.type==='FRAME')) {await preserve();return;}
    const table=nativeTable(node,bounds,origin);
    if(table){items.push(table);return;}
    if(node.type==='TEXT'){
      const text=nativeText(node,bounds,origin);
      if(text) items.push(text);
      else if(node.characters) await preserve();
    }else if(node.type==='FRAME'||node.type==='GROUP'){
      const hidesChildren=node.children.some(child=>{
        const rendered=renderBounds(child);
        return ('isMask' in child&&child.isMask)||(!whole&&'clipsContent' in node&&node.clipsContent&&child.visible&&!!rendered&&!within(rendered,bounds));
      });
      if(hidesChildren){await preserve();return;}
      let background:SlideItem|null|undefined=null;
      if(node.type==='FRAME'){
        background=visibleEffects(node).length?undefined:nativeShape(node,bounds,origin);
        if(background===undefined) background=frameSurface(node,bounds,origin);
      }
      if(background===undefined){await preserve();return;}
      if(background){
        if(background.kind==='svg') consume(background.bytes);
        items.push(background);
      }
      for(const child of node.children) await visit(child);
    }else if(node.type==='RECTANGLE'||node.type==='ELLIPSE'){
      const shape=nativeShape(node,bounds,origin);
      if(shape) items.push(shape);
      else if(shape===undefined) await preserve();
    }else await preserve();
  }

  if(mode==='image'||!frame.absoluteBoundingBox) await raster(frame,rootBounds,true);
  else await visit(frame);
  return {items,width:frame.width,height:frame.height};
}
