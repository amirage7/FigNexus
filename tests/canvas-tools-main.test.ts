import { expect, it, vi } from 'vitest';
import { createCanvasTools } from '../apps/figma-plugin/src/canvas-tools-main';
import { buildPresentation } from '../apps/figma-plugin/src/canvas-pptx';
import type { CanvasCommand } from '../apps/figma-plugin/src/canvas-tools-model';
import { fixture } from './figma-fixture';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64'));

function setup(){
  const f=fixture();
  f.api.viewport={center:{x:0,y:0},scrollAndZoomIntoView:vi.fn()};
  const createFrame=f.api.createFrame;
  f.api.createFrame=()=>{
    const frame=createFrame();
    frame.rotation=0;
    Object.defineProperties(frame,{
      gridRowSizes:{get:()=>Array.from({length:frame.gridRowCount},()=>({type:'FLEX'}))},
      gridColumnSizes:{get:()=>Array.from({length:frame.gridColumnCount},()=>({type:'FLEX'}))},
    });
    return frame;
  };
  f.api.createVector=()=>f.make('VECTOR');
  f.page.findAllWithCriteria=()=>[...f.nodes.values()].filter(node=>node.type==='VECTOR'&&node.getPluginDataKeys().length);
  const post=vi.fn();
  const tools=createCanvasTools(f.api,post);
  return {...f,post,tools,run:(command:CanvasCommand)=>tools.prepare(command)()};
}

it('creates native 16:9 slides and exports exactly the requested slide order',async()=>{
  const f=setup();
  await f.run({type:'canvas-slides',id:'create',pageId:'p',count:2,template:false});
  const [first,second]=f.page.selection;
  expect(first).toMatchObject({name:'01 幻灯片',width:1920,height:1080,type:'FRAME'});
  expect(second.x).toBeGreaterThan(first.x);
  const order:string[]=[];
  first.exportAsync=async()=>{order.push('first');return png;};
  second.exportAsync=async()=>{order.push('second');return png;};
  const command={type:'canvas-export',id:'export',pageId:'p',frameIds:[second.id,first.id]} as const;
  await f.run({...command,frameIds:[...command.frameIds]});
  expect(order).toEqual(['second','first']);
  expect(f.post.mock.calls.map(([message])=>message)).toContainEqual({type:'canvas-done',id:'export',message:'已渲染所选画板。',fileName:'Test.pptx',size:{width:1920,height:1080}});
  f.page.selection=[first];
  await f.run({...command,id:'stale',frameIds:[...command.frameIds]});
  expect(f.post.mock.calls.map(([message])=>message)).toContainEqual(expect.objectContaining({type:'canvas-error',id:'stale'}));
  expect(order).toHaveLength(2);
});

it('inserts a native grid with editable pasted cells into the selected frame',async()=>{
  const f=setup(), parent=f.api.createFrame();
  parent.resize(1000,600);
  f.page.selection=[parent];
  await f.run({type:'canvas-table',id:'table',pageId:'p',rows:1,columns:1,text:'项目\t数值\n试验\t12%',header:true});
  const [grid]=parent.children;
  expect(grid).toMatchObject({type:'FRAME',layoutMode:'GRID',gridRowCount:2,gridColumnCount:2});
  expect(grid.children.map((cell:any)=>cell.children[0].characters)).toEqual(['项目','数值','试验','12%']);
  expect(grid.children[3].children[0].textAlignHorizontal).toBe('RIGHT');
  expect(grid.fills).toEqual([]);
  expect(grid.children.every((cell:any)=>cell.fills.length===0)).toBe(true);
  expect(grid.children[0].strokeRightWeight).toBe(1);
  await f.run({type:'canvas-table-update',id:'table-size',pageId:'p',tableId:grid.id,columnWidths:[180,120],rowHeights:[55,65],fill:'#EEEEEE'});
  expect(grid).toMatchObject({width:300,height:120});
  expect(grid.children[1]).toMatchObject({width:120,height:55,fills:[{type:'SOLID'}]});
  expect(grid.children[3].children[0].characters).toBe('12%');
  expect(f.api.commitUndo).toHaveBeenCalledTimes(2);
});

it('inserts a seven-row spreadsheet with thirteen columns into the selected slide',async()=>{
  const f=setup(),parent=f.api.createFrame();
  parent.resize(1920,1080);
  f.page.selection=[parent];
  const source=Array.from({length:7},(_,row)=>Array.from({length:13},(_,column)=>column===10?'':String(row*13+column)).join('\t')).join('\n');
  await f.run({type:'canvas-table',id:'wide-table',pageId:'p',rows:4,columns:3,text:source,header:true});
  const [grid]=parent.children;
  expect(grid).toMatchObject({gridColumnCount:13,gridRowCount:7});
  expect(grid.children).toHaveLength(91);
  expect(grid.children[10].children[0].characters).toBe('');
  expect(grid.children[12].children[0].characters).toBe('12');
});

it('exports portrait slides with a custom filename, native text, and a high-resolution image fallback',async()=>{
  const f=setup();
  await f.run({type:'canvas-slides',id:'portrait',pageId:'p',count:1,template:false,size:{width:1080,height:1920}});
  const [frame]=f.page.selection;
  frame.absoluteBoundingBox={x:0,y:0,width:1080,height:1920};
  const text=f.make('TEXT');
  text.characters='可编辑正文';
  text.textCase='ORIGINAL';
  text.fills=[{type:'SOLID',color:{r:0,g:0,b:0}}];
  text.absoluteBoundingBox={x:40,y:40,width:400,height:100};
  frame.appendChild(text);
  const vector=f.make('VECTOR');
  vector.absoluteBoundingBox={x:40,y:200,width:400,height:100};
  vector.exportAsync=vi.fn(async()=>png);
  frame.appendChild(vector);
  await f.run({type:'canvas-export',id:'editable',pageId:'p',frameIds:[frame.id],title:'答辩定稿',quality:'ultra',mode:'editable'});
  expect(vector.exportAsync).toHaveBeenCalledWith(expect.objectContaining({constraint:{type:'SCALE',value:2}}));
  expect(f.post.mock.calls.map(([message])=>message)).toContainEqual(expect.objectContaining({
    type:'canvas-progress',id:'editable',slide:{width:1080,height:1920,items:[
      expect.objectContaining({kind:'text',text:'可编辑正文',x:40,y:40}),
      expect.objectContaining({kind:'image',x:40,y:200}),
    ]},
  }));
  expect(f.post.mock.calls.map(([message])=>message)).toContainEqual(expect.objectContaining({type:'canvas-done',fileName:'答辩定稿.pptx',size:{width:1080,height:1920}}));
});

it('preserves horizontal and diagonal Figma lines as native shapes and complex vectors as SVG',async()=>{
  const f=setup(),frame=f.api.createFrame();
  frame.resize(1920,1080);
  frame.absoluteBoundingBox={x:0,y:0,width:1920,height:1080};
  f.page.selection=[frame];
  for(const [width,dy] of [[200,0],[141.421356,-100]]){
    const line=f.make('LINE');
    line.width=width;line.height=0;
    line.absoluteBoundingBox={x:20,y:dy?20:120,width:dy?100:200,height:Math.abs(dy)};
    line.absoluteTransform=dy?[[Math.SQRT1_2,Math.SQRT1_2,20],[-Math.SQRT1_2,Math.SQRT1_2,120]]:[[1,0,20],[0,1,120]];
    line.strokes=[{type:'SOLID',color:{r:0,g:0,b:0}}];
    line.strokeWeight=2;
    line.strokeCap='NONE';
    frame.appendChild(line);
  }
  const vector=f.make('VECTOR');
  vector.absoluteBoundingBox={x:50,y:210,width:30,height:20};
  const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><path d="M0 0 Q 20 20 30 0" fill="none" stroke="black"/></svg>');
  vector.exportAsync=vi.fn(async()=>svg);
  frame.appendChild(vector);
  await f.run({type:'canvas-export',id:'paths',pageId:'p',frameIds:[frame.id],mode:'editable'});
  const result=f.post.mock.calls.map(([message])=>message).find(message=>message.type==='canvas-progress');
  expect(result?.slide.items.map((item:any)=>item.kind)).toEqual(['line','line','svg']);
  expect(result?.slide.items[0]).toMatchObject({x:20,y:120,x2:220,y2:120,strokeWidth:2});
  expect(result?.slide.items[1].y2).toBeCloseTo(20);
  expect(vector.exportAsync).toHaveBeenCalledWith(expect.objectContaining({format:'SVG',svgSimplifyStroke:false}));
  const deck=Buffer.from(await buildPresentation([result!.slide],'Native line and SVG'));
  expect(deck.includes('<a:prstGeom prst="line">')).toBe(true);
  expect(deck.includes('asvg:svgBlip')).toBe(true);
  expect(deck.includes(Buffer.from(svg))).toBe(true);
});

it('keeps editable text and separate photos inside a gradient slide and a rounded shadowed frame',async()=>{
  const f=setup(),slide=f.api.createFrame(),card=f.api.createFrame();
  slide.resize(1920,1080);
  slide.absoluteBoundingBox={x:0,y:0,width:1920,height:1080};
  slide.clipsContent=true;
  slide.fills=[{type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[
    {position:0,color:{r:1,g:1,b:1,a:1}},{position:1,color:{r:1,g:0.9,b:0.9,a:1}},
  ]}];
  card.resize(800,400);
  card.absoluteBoundingBox={x:50,y:100,width:800,height:400};
  card.cornerRadius=18;
  card.effects=[{type:'DROP_SHADOW',visible:true,color:{r:0,g:0,b:0,a:0.1},offset:{x:0,y:6},radius:16,spread:0,blendMode:'NORMAL'}];
  card.fills=[{type:'SOLID',color:{r:1,g:0.9,b:0.9}}];
  slide.appendChild(card);
  const text=f.make('TEXT');
  text.characters='标题保持可编辑';
  text.textCase='ORIGINAL';
  text.fills=[{type:'SOLID',color:{r:0,g:0,b:0}}];
  text.absoluteBoundingBox={x:80,y:135,width:420,height:60};
  card.appendChild(text);
  for(const x of [330,560]){
    const photo=f.make('RECTANGLE');
    photo.absoluteBoundingBox={x,y:250,width:220,height:200};
    photo.fills=[{type:'IMAGE',imageHash:'photo-'+x,scaleMode:'FILL'}];
    photo.exportAsync=vi.fn(async()=>png);
    card.appendChild(photo);
  }
  slide.exportAsync=vi.fn(async()=>png);
  card.exportAsync=vi.fn(async()=>png);
  f.page.selection=[slide];
  await f.run({type:'canvas-export',id:'nested-editable',pageId:'p',frameIds:[slide.id],mode:'editable'});
  const result=f.post.mock.calls.map(([message])=>message).find(message=>message.type==='canvas-progress');
  expect(result?.slide.items.map((item:any)=>item.kind)).toEqual(['svg','svg','text','image','image']);
  expect(slide.exportAsync).not.toHaveBeenCalled();
  expect(card.exportAsync).not.toHaveBeenCalled();
  expect(result?.slide.items[2].text).toBe('标题保持可编辑');
  // An inseparable effect falls back visually, but an SVG containing bitmap
  // photos must not be used as its PowerPoint representation.
  card.effects=[{type:'LAYER_BLUR',visible:true,radius:12}];
  card.exportAsync=vi.fn(async(settings)=>settings.format==='SVG'
    ?new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>'):png);
  f.post.mockClear();
  await f.run({type:'canvas-export',id:'blurred-cluster',pageId:'p',frameIds:[slide.id],mode:'editable'});
  const fallback=f.post.mock.calls.map(([message])=>message).find(message=>message.type==='canvas-progress');
  expect(fallback?.slide.items.map((item:any)=>item.kind)).toEqual(['svg','image']);
  expect(card.exportAsync).toHaveBeenCalledWith(expect.objectContaining({format:'PNG'}));
});

it('moves existing connector geometry with an endpoint and reverses its saved direction',async()=>{
  const f=setup(),from=f.make('RECTANGLE'),to=f.make('RECTANGLE');
  from.absoluteBoundingBox={x:0,y:0,width:100,height:100};
  to.absoluteBoundingBox={x:250,y:100,width:100,height:100};
  f.page.selection=[from,to];
  await f.run({type:'canvas-connect',id:'connect',pageId:'p',kind:'elbow',reverse:false});
  const [vector]=f.page.selection;
  expect(vector.type).toBe('VECTOR');
  const original=vector.vectorPaths[0].data;
  to.absoluteBoundingBox={x:400,y:70,width:100,height:100};
  await f.tools.refresh(f.page);
  const moved=vector.vectorPaths[0].data;
  expect(moved).not.toBe(original);
  await f.run({type:'canvas-reverse',id:'reverse',pageId:'p'});
  expect(vector.vectorPaths[0].data).not.toBe(moved);
  expect(JSON.parse(vector.getPluginData(vector.getPluginDataKeys()[0]))).toMatchObject({from:to.id,to:from.id});
});

it('packages one image on each slide into a real PowerPoint ZIP container',async()=>{
  const deck=Buffer.from(await buildPresentation([png,png],'FigNexus test'));
  expect(deck.subarray(0,4)).toEqual(Buffer.from([80,75,3,4]));
  expect(deck.includes('ppt/presentation.xml')).toBe(true);
  expect(deck.includes('ppt/slides/slide1.xml')).toBe(true);
  expect(deck.includes('ppt/slides/slide2.xml')).toBe(true);
});
