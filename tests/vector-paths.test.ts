import {expect,it} from 'vitest';
import {VectorPathsInputSchema,NativeVectorPathsSchema,StrokeCapSchema,StrokeJoinSchema} from '../packages/protocol/src/vector';
import {toNativeVectorPaths,serializeVectorPaths} from '../apps/figma-plugin/src/vector';

const move={op:'M',x:0,y:0};
const line={op:'L',x:10,y:20};
const path=(commands:unknown[])=>({windingRule:'NONZERO',commands});
it('converts all supported commands to native editable path data',()=>{
 const input=[path([move,line,{op:'Q',x1:11,y1:21,x:12,y:22},{op:'C',x1:13,y1:23,x2:14,y2:24,x:15,y:25},{op:'Z'}])];
 expect(toNativeVectorPaths(input)).toEqual([{windingRule:'NONZERO',data:'M 0 0 L 10 20 Q 11 21 12 22 C 13 23 14 24 15 25 Z'}]);
});
it('accepts multiple open and closed drawable subpaths',()=>{
 expect(VectorPathsInputSchema.safeParse([path([move,line,{op:'Z'},{op:'M',x:30,y:40},line])]).success).toBe(true);
 expect(VectorPathsInputSchema.safeParse([{windingRule:'EVENODD',commands:[move,line]}]).success).toBe(true);
});
it('rejects unsupported opcodes, raw SVG and extra command fields',()=>{
 for(const input of ['M 0 0 L 10 20',[{windingRule:'NONZERO',data:'M 0 0 L 1 1'}],[path([move,{op:'A',x:1,y:1}])],[path([move,{...line,code:'run()'}])],[{...path([move,line]),svg:'<svg/>'}],[{windingRule:'NONE',commands:[move,line]}]]){
  expect(VectorPathsInputSchema.safeParse(input).success).toBe(false);
  expect(()=>toNativeVectorPaths(input)).toThrow();
 }
});
it('rejects incomplete paths and drawing after closure without a new move',()=>{
 for(const commands of [[],[line],[move],[move,{op:'Z'}],[move,line,{op:'Z'},{op:'Z'}],[move,line,{op:'Z'},line],[move,{op:'M',x:1,y:2},line],[move,line,{op:'M',x:1,y:2}]])
  expect(VectorPathsInputSchema.safeParse([path(commands)]).success).toBe(false);
});
it('requires finite bounded coordinates for every handle and endpoint',()=>{
 for(const value of [Infinity,-Infinity,NaN,10001,-10001]){
  expect(VectorPathsInputSchema.safeParse([path([{...move,x:value},line])]).success).toBe(false);
  expect(VectorPathsInputSchema.safeParse([path([move,{op:'C',x1:0,y1:0,x2:value,y2:0,x:1,y:1}])]).success).toBe(false);
  expect(VectorPathsInputSchema.safeParse([path([move,{op:'Q',x1:0,y1:value,x:1,y:1}])]).success).toBe(false);
 }
 expect(VectorPathsInputSchema.safeParse([path([{op:'M',x:-10000,y:10000},line])]).success).toBe(true);
});
it('bounds path counts, per-path commands and aggregate commands',()=>{
 const full=path([move,...Array(255).fill(line)]);
 expect(VectorPathsInputSchema.safeParse(Array(4).fill(full)).success).toBe(true);
 for(const input of [[],Array(17).fill(path([move,line])),[path([move,...Array(256).fill(line)])],Array(5).fill(full)])
  expect(VectorPathsInputSchema.safeParse(input).success).toBe(false);
});
it('preserves Figma native data and NONE winding rule on readback',()=>{
 const native=[{windingRule:'NONE',data:'M 0 0 C 1 1 2 2 3 3'}] as const;
 expect(serializeVectorPaths(native)).toEqual({vectorPaths:native,vectorPathsTruncated:false});
 expect(NativeVectorPathsSchema.safeParse(native).success).toBe(true);
 expect(NativeVectorPathsSchema.safeParse([]).success).toBe(true);
});
it('omits oversized whole paths without cutting data into invalid fragments',()=>{
 const short={windingRule:'NONZERO',data:'M 0 0 L 1 1'} as const;
 const huge={windingRule:'EVENODD',data:'x'.repeat(32769)} as const;
 expect(serializeVectorPaths([huge,short])).toEqual({vectorPaths:[short],vectorPathsTruncated:true});
 const native=[{...short,data:'a'.repeat(5000)},{...short,data:'b'.repeat(5000)},short];
 expect(serializeVectorPaths(native)).toEqual({vectorPaths:[native[0],short],vectorPathsTruncated:true});
 expect(serializeVectorPaths(Array(17).fill(short))).toEqual({vectorPaths:Array(16).fill(short),vectorPathsTruncated:true});
 expect(NativeVectorPathsSchema.safeParse([huge]).success).toBe(false);
 expect(NativeVectorPathsSchema.safeParse(native).success).toBe(false);
});
it('drops unsupported native entries and extra native fields',()=>{
 const short={windingRule:'NONZERO',data:'M 0 0 L 1 1'} as const;
 expect(serializeVectorPaths([{...short,extra:'ignore'},{windingRule:'BAD',data:'x'}] as any)).toEqual({vectorPaths:[short],vectorPathsTruncated:true});
});
it('allows only the specified cap and join enums',()=>{
 for(const cap of ['NONE','ROUND','SQUARE'])expect(StrokeCapSchema.safeParse(cap).success).toBe(true);
 for(const join of ['MITER','ROUND','BEVEL'])expect(StrokeJoinSchema.safeParse(join).success).toBe(true);
 expect(StrokeCapSchema.safeParse('ARROW_LINES').success).toBe(false);
 expect(StrokeJoinSchema.safeParse('CURVED').success).toBe(false);
});
