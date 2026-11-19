import type { SlideItem } from './canvas-tools-model';

const value=(n:number)=>Math.round(n*10000)/10000;
const visible=(paint:Paint)=>paint.visible!==false&&(paint.opacity??1)>0;
const color=({r,g,b}:RGB)=>'rgb('+[r,g,b].map(n=>Math.round(n*255)).join(',')+')';

export function visibleEffects(frame:FrameNode) {
  return (frame.effects??[]).filter(effect=>effect.visible!==false);
}

export function frameSurface(frame:FrameNode,bounds:Rect,origin:Rect):SlideItem|null|undefined {
  if(!Array.isArray(frame.fills)||!Array.isArray(frame.strokes??[])) return;
  const fills=(frame.fills as readonly Paint[]).filter(visible);
  const strokes=(frame.strokes??[]).filter(visible);
  const effects=visibleEffects(frame);
  if(effects.some(effect=>effect.type!=='DROP_SHADOW'||(effect.blendMode&&effect.blendMode!=='NORMAL'))) return;
  const shadows=effects.filter((effect):effect is DropShadowEffect=>effect.type==='DROP_SHADOW');
  if(strokes.length&&(typeof frame.strokeWeight!=='number'||frame.dashPattern?.length)) return;
  if(shadows.length&&!fills.length) return;
  if(!fills.length&&!strokes.length&&!shadows.length) return null;
  const {width,height}=bounds;
  const radius=typeof frame.cornerRadius==='number'?frame.cornerRadius:0;
  if(typeof frame.cornerRadius==='symbol') return;
  const defs:string[]=[];
  function style(paint:Paint,key:string) {
    if(paint.blendMode&&paint.blendMode!=='NORMAL') return;
    if(paint.type==='SOLID') return {color:color(paint.color),opacity:paint.opacity??1};
    if(paint.type!=='GRADIENT_LINEAR'&&paint.type!=='GRADIENT_RADIAL') return;
    const [[a,b,c],[d,e,f]]=paint.gradientTransform;
    const det=a*e-b*d;
    if(!Number.isFinite(det)||!det) return;
    const matrix=[e,-d,-b,a,b*f-e*c,d*c-a*f].map(n=>value(n/det)).join(' ');
    const linear=paint.type==='GRADIENT_LINEAR';
    const tag=linear?'linearGradient':'radialGradient';
    const axis=linear?'x1="0" y1=".5" x2="1" y2=".5"':'cx=".5" cy=".5" r=".5"';
    const stops=paint.gradientStops.map(stop=>'<stop offset="'+value(stop.position)+'" stop-color="'+color(stop.color)+'" stop-opacity="'+value(stop.color.a)+'"/>').join('');
    defs.push('<'+tag+' id="'+key+'" '+axis+' gradientTransform="matrix('+matrix+')">'+stops+'</'+tag+'>');
    return {color:'url(#'+key+')',opacity:paint.opacity??1};
  }
  const fillStyles=fills.map((paint,i)=>style(paint,'f'+i));
  const strokeStyles=strokes.map((paint,i)=>style(paint,'s'+i));
  if(fillStyles.some(item=>!item)||strokeStyles.some(item=>!item)) return;
  const strokeWeight=strokes.length?Number(frame.strokeWeight):0;
  const strokeInset=frame.strokeAlign==='INSIDE'?strokeWeight/2:frame.strokeAlign==='OUTSIDE'?-strokeWeight/2:0;
  const rect=(x:number,y:number,w:number,h:number,r:number,attrs:string)=>
    '<rect x="'+value(x)+'" y="'+value(y)+'" width="'+value(Math.max(0,w))+'" height="'+value(Math.max(0,h))+'" rx="'+value(Math.max(0,r))+'" '+attrs+'/>';
  const maxEffect=shadows.reduce((max,shadow)=>Math.max(max,Math.abs(shadow.offset.x),Math.abs(shadow.offset.y)),0);
  const softness=shadows.reduce((max,shadow)=>Math.max(max,shadow.radius*2+Math.abs(shadow.spread??0)),0);
  const pad=Math.ceil(strokeWeight+maxEffect+softness);
  const blurred=shadows.map((shadow,index)=>{
    if(!fills.length||shadow.color.a===0) return '';
    const filter='shadow'+index;
    if(shadow.radius>0) defs.push('<filter id="'+filter+'" filterUnits="userSpaceOnUse" x="'+(-pad)+'" y="'+(-pad)+'" width="'+value(width+pad*2)+'" height="'+value(height+pad*2)+'"><feGaussianBlur stdDeviation="'+value(shadow.radius/2)+'"/></filter>');
    const spread=shadow.spread??0;
    return rect(shadow.offset.x-spread,shadow.offset.y-spread,width+spread*2,height+spread*2,radius+spread,
      'fill="'+color(shadow.color)+'" opacity="'+value(shadow.color.a)+'"'+(shadow.radius>0?' filter="url(#'+filter+')"':''));
  }).join('');
  const painted=fillStyles.map(item=>rect(0,0,width,height,radius,'fill="'+item!.color+'" fill-opacity="'+value(item!.opacity)+'"')).join('');
  const borders=strokeStyles.map(item=>rect(strokeInset,strokeInset,width-strokeInset*2,height-strokeInset*2,radius-strokeInset,
    'fill="none" stroke="'+item!.color+'" stroke-width="'+value(strokeWeight)+'" stroke-opacity="'+value(item!.opacity)+'"')).join('');
  const w=width+pad*2,h=height+pad*2;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+value(w)+'" height="'+value(h)+'" viewBox="'+[-pad,-pad,value(w),value(h)].join(' ')+'"><defs>'+defs.join('')+'</defs>'+blurred+painted+borders+'</svg>';
  return {kind:'svg',x:bounds.x-origin.x-pad,y:bounds.y-origin.y-pad,width:w,height:h,bytes:Uint8Array.from(svg,c=>c.charCodeAt(0))};
}
