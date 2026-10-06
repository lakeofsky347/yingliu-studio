import { addShot } from '../core/index.ts';
import type { VideoProject, VideoTarget } from '../shared/types.ts';
export interface ProjectSummary {id:string;path:string;title:string;archived?:boolean;archivedAt?:string;updatedAt?:string;revision?:number}
export interface PackCatalog {art:{id:string;name:string;summary:string;palette?:Record<string,string>;status?:string}[];profiles:{id:string;notes?:string;overrides:{target?:Partial<VideoTarget>}}[]}
export interface CreateBrief {title:string;topic:string;duration:number;profile:string;preset:string;mode:'blank'|'ai'}
export const OUTPUT_PROFILES=[{id:'presentation-landscape',name:'横屏影片',detail:'16:9 · 1920 × 1080',width:1920,height:1080},{id:'social-vertical',name:'竖屏短片',detail:'9:16 · 1080 × 1920',width:1080,height:1920},{id:'square',name:'方形画面',detail:'1:1 · 1080 × 1080',width:1080,height:1080}];
export function briefPayload(brief:CreateBrief){
  if(!brief.title.trim())throw new Error('请给影片起一个名称');if(!Number.isFinite(brief.duration)||brief.duration<1||brief.duration>3600)throw new Error('目标片长应在 1–3600 秒之间');
  if(brief.mode==='ai'&&!brief.topic.trim())throw new Error('生成初稿需要主题与创作简报');
  const profile=OUTPUT_PROFILES.find(item=>item.id===brief.profile);if(!profile)throw new Error('请选择输出规格');
  return {title:brief.title.trim(),topic:brief.topic.trim(),targetDuration:brief.duration,profile:brief.profile,preset:brief.preset,blank:true,target:{width:profile.width,height:profile.height,fps:{num:30,den:1},audioMode:'none' as const,quality:'standard' as const}};
}
/** Newly added shots and the output node remain distinct even in an empty project. */
export function addPlacedShot(project:VideoProject,afterId?:string):VideoProject{
  const next=addShot(project,undefined,afterId);const added=next.shots.find(shot=>!project.shots.some(old=>old.id===shot.id))!;
  const previous=afterId?project.graph.positions[afterId]:undefined;
  const shotPositions=project.shots.map(shot=>project.graph.positions[shot.id]).filter((value):value is [number,number]=>!!value);
  const x=previous?previous[0]+340:shotPositions.length?Math.max(...shotPositions.map(position=>position[0]))+340:100;
  const y=previous?previous[1]+40:140;
  next.graph.positions[added.id]=[x,y];const output=next.graph.positions['film-output'];
  if(!output||Math.abs(output[0]-x)<300&&Math.abs(output[1]-y)<260)next.graph.positions['film-output']=[x+360,y];
  return next;
}
/** Retain user layout unless an inherited output position obscures a shot. */
export function outputPositionWithoutOverlap(position:[number,number],shots:{position:[number,number];size:[number,number]}[],outputSize:[number,number]=[252,184]):[number,number]{
  const overlaps=shots.some(shot=>position[0]<shot.position[0]+shot.size[0]+12&&position[0]+outputSize[0]+12>shot.position[0]&&position[1]<shot.position[1]+shot.size[1]+12&&position[1]+outputSize[1]+12>shot.position[1]);
  if(!overlaps)return [...position];
  return [Math.max(...shots.map(shot=>shot.position[0]+shot.size[0]))+70,shots.at(-1)?.position[1]??position[1]];
}
