import type PptxGenJS from 'pptxgenjs';
import type {CanvasSize,SlidePage} from './canvas-tools-model';

export const PPTX_MIME='application/vnd.openxmlformats-officedocument.presentationml.presentation';

function imageData(bytes:Uint8Array,type='image/png') {
  const parts:string[]=[];
  for(let offset=0;offset<bytes.length;offset+=0x8000) parts.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));
  return 'data:'+type+';base64,'+btoa(parts.join(''));
}

export async function buildPresentation(pages:readonly (SlidePage|Uint8Array)[],title:string,size:CanvasSize={width:1920,height:1080}):Promise<ArrayBuffer> {
  if(!pages.length) throw Error('没有可导出的画板。');
  const module=await import('pptxgenjs');
  const Constructor=module.default as typeof PptxGenJS;
  const deck=new Constructor();
  const ratio=size.width/size.height;
  const width=Math.min(13.333333333,13.333333333*ratio),height=width/ratio;
  deck.defineLayout({name:'FIGNEXUS',width,height});
  deck.layout='FIGNEXUS';
  deck.title=title;
  deck.author='FigNexus';
  for(const page of pages){
    const slide=deck.addSlide();
    if(page instanceof Uint8Array){
      slide.addImage({data:imageData(page),x:0,y:0,w:width,h:height});
      continue;
    }
    const sx=width/(page.width??size.width),sy=height/(page.height??size.height);
    for(const item of page.items){
      if(item.kind==='line'){
        const dx=item.x2-item.x,dy=item.y2-item.y;
        slide.addShape('line',{
          x:Math.min(item.x,item.x2)*sx,y:Math.min(item.y,item.y2)*sy,w:Math.abs(dx)*sx,h:Math.abs(dy)*sy,
          flipH:dx<0,flipV:dy<0,line:{color:item.stroke,width:item.strokeWidth*sy*72},
        });
        continue;
      }
      const box={x:item.x*sx,y:item.y*sy,w:item.width*sx,h:item.height*sy};
      if(item.kind==='image'||item.kind==='svg'){
        slide.addImage({...box,data:imageData(item.bytes,item.kind==='svg'?'image/svg+xml':'image/png')});
      }else if(item.kind==='text'){
        slide.addText(item.text,{...box,fontFace:item.font,fontSize:item.fontSize*sy*72,color:item.color,bold:item.bold,
          italic:item.italic,align:item.align,valign:item.valign,margin:0,fit:'none',wrap:item.wrap??true});
      }else if(item.kind==='table'){
        const rows=item.rows.map(row=>row.map(cell=>({text:cell.text,options:{
          fill:cell.fill?{color:cell.fill}:undefined,color:cell.color,bold:cell.bold,align:cell.align,
          fontSize:(cell.fontSize??16)*sy*72,
        }})));
        slide.addTable(rows,{...box,autoPage:false,colW:item.columnWidths.map(value=>value*sx),rowH:item.rowHeights.map(value=>value*sy),
          margin:2,border:{type:'solid',pt:0.5,color:'303030'},valign:'middle',fontFace:'Arial'});
      }else{
        slide.addShape(item.shape,{...box,fill:item.fill?{color:item.fill}:{transparency:100},
          line:item.stroke?{color:item.stroke,width:(item.strokeWidth??1)*sy*72}:{transparency:100}});
      }
    }
  }
  const data=await deck.write({outputType:'arraybuffer',compression:false});
  if(!(data instanceof ArrayBuffer)) throw Error('PowerPoint 文件生成失败。');
  return data;
}
