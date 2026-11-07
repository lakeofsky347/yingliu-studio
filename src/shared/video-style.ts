import type {VideoStyle} from './types.ts';

/** Text-only style data is copied into the project; imports never become executable code. */
export function normalizeVideoStyle(value:unknown):VideoStyle {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('制作风格须为对象');
  const input=value as Record<string,unknown>;
  const id=typeof input.id==='string'?input.id.trim():'';
  const name=typeof input.name==='string'?input.name.trim():'';
  const prompt=typeof input.prompt==='string'?input.prompt.trim():'';
  if(!id||id.length>255)throw new Error('风格 ID 须为 1–255 个字符');
  if(!name||name.length>100)throw new Error('风格名称须为 1–100 个字符');
  if(!prompt||prompt.length>80000)throw new Error('风格描述须为 1–80000 个字符');
  const formats=['markdown','json','zip','folder','custom'] as const;
  const sourceFormat=formats.includes(input.sourceFormat as typeof formats[number])?input.sourceFormat as VideoStyle['sourceFormat']:'custom';
  const now=new Date().toISOString();
  const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():now;
  return {id,name,prompt,description:typeof input.description==='string'?input.description.slice(0,1000):'',sourceFormat,
    sourceName:typeof input.sourceName==='string'?input.sourceName.slice(0,255):name,
    createdAt:timestamp(input.createdAt),updatedAt:timestamp(input.updatedAt)};
}
