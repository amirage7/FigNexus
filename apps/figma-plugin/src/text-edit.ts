// Preserve style boundaries by character index. New trailing characters inherit
// the final source segment; node-level alignment and auto resize stay untouched.
const fields=['fontName','fontSize','fills','textCase','textDecoration','lineHeight','letterSpacing','listOptions','listSpacing','indentation','paragraphIndent','paragraphSpacing','hyperlink'] as const;
export function textReplacement(node:TextNode,characters:string){
 const oldLength=node.characters.length;
 const segments=oldLength&&typeof node.getStyledTextSegments==='function'?node.getStyledTextSegments([...fields]):[];
 return ()=>{
  node.characters=characters;
  for(let i=0;i<segments.length;i++){
   const segment=segments[i],start=segment.start,end=Math.min(characters.length,i===segments.length-1?characters.length:segment.end);
   if(start>=end)continue;
   for(const field of fields){
    if(segment[field]===undefined)continue;
    const key=`setRange${field[0].toUpperCase()}${field.slice(1)}`;
    const setter=(node as unknown as Record<string,unknown>)[key];
    if(typeof setter!=='function')throw Error(`TEXT_STYLE_UNSUPPORTED: ${key}`);
    setter.call(node,start,end,segment[field]);
   }
  }
 };
}
