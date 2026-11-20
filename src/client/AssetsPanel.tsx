import { useRef, useState } from 'react';
import type { Asset, VideoProject } from '../shared/types.ts';
import { Icon, IconButton } from './icons.tsx';

const ACCEPT='image/png,image/jpeg,image/webp,.txt,.md,text/plain,text/markdown,audio/*,video/*,.mp4,.mov,.m4v,.webm,.mkv,.wav,.mp3,.m4a,.aac,.flac,.ogg';
type Kind='all'|Asset['kind'];
const KIND_ICON:Record<Asset['kind'],string>={image:'image',text:'text',audio:'music',video:'video'};

export function AssetsPanel({project,selectedId,assetUrl,pending,locked,onSelect,onImport,onAddText,onDelete,onClose}:{
  project:VideoProject;selectedId:string|null;assetUrl:(asset:Asset)=>string;pending:boolean;locked:boolean;
  onSelect:(id:string)=>void;onImport:(files:FileList)=>void;onAddText:()=>void;onDelete:(asset:Asset)=>void;onClose?:()=>void;
}){
  const file=useRef<HTMLInputElement>(null),[query,setQuery]=useState(''),[kind,setKind]=useState<Kind>('all'),[dropping,setDropping]=useState(0);
  const needle=query.trim().toLocaleLowerCase();
  const counts=project.assets.reduce<Record<string,number>>((all,asset)=>({...all,[asset.kind]:(all[asset.kind]||0)+1}),{});
  const kinds=(['image','text','audio','video'] as const).filter(value=>counts[value]);
  const activeKind=kind==='all'||counts[kind]?kind:'all';
  const visible=project.assets.filter(asset=>(activeKind==='all'||asset.kind===activeKind)&&(!needle||`${asset.name} ${asset.description} ${asset.text||''}`.toLocaleLowerCase().includes(needle)));
  const uses=(asset:Asset)=>project.shots.filter(shot=>shot.assetIds.includes(asset.id)||shot.referenceIds.includes(asset.id)).length;
  const label:Record<Kind,string>={all:"全部",image:"图片",text:"文字",audio:"音频",video:"视频"};
  return <aside className={`vs-assets-panel ${dropping?'is-dropping':''}`} aria-label="资产库"
    onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();if(!locked)setDropping(value=>value+1);}}}
    onDragLeave={event=>{if(event.dataTransfer.types.includes('Files'))setDropping(value=>Math.max(0,value-1));}}
    onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
    onDrop={event=>{setDropping(0);if(event.dataTransfer.files.length){event.preventDefault();if(!locked)onImport(event.dataTransfer.files);}}}>
    <div className="vs-panel-header">
      <h2>{"资产库 "}<small>{project.assets.length}</small></h2>
      <div className="vs-panel-header-actions">
        <IconButton icon="text" label="添加文字" onClick={onAddText} disabled={locked}/>
        <IconButton icon="upload" label="导入素材" onClick={()=>file.current?.click()} disabled={pending||locked}/>
        {onClose&&<IconButton icon="close" className="vs-assets-close" label="收起资产库" onClick={onClose}/>}
      </div>
    </div>
    <div className="vs-search-box"><Icon name="search"/><input className="vs-search" type="search" aria-label="搜索资产" placeholder="搜索图片、文字、音频和视频…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    {kinds.length>1&&<div className="vs-chip-row" role="group" aria-label="按类型筛选">{(['all',...kinds] as Kind[]).map(value=><button type="button" key={value} aria-pressed={activeKind===value} className={`vs-chip ${activeKind===value?'is-active':''}`} onClick={()=>setKind(value)}>{label[value]}<small>{value==='all'?project.assets.length:counts[value]}</small></button>)}</div>}
    <input ref={file} hidden multiple type="file" accept={ACCEPT} onChange={e=>{if(e.target.files)onImport(e.target.files);e.target.value='';}}/>
    <div className="vs-assets">
      {visible.map(asset=>{const count=uses(asset),url=asset.kind==='image'?assetUrl(asset):'';return <div key={asset.id} className={`vs-asset ${selectedId===asset.id?'is-selected':''}`}>
        <button type="button" className="vs-asset-main" draggable onDragStart={e=>{e.dataTransfer.setData('application/x-yingliu-asset',asset.id);e.dataTransfer.effectAllowed='move';}} onClick={()=>onSelect(asset.id)} aria-pressed={selectedId===asset.id}>
          <span className={`vs-asset-thumb is-${asset.kind}`}>{url?<img src={url} alt="" loading="lazy"/>:asset.kind==='audio'?<span className="vs-mini-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span>:<Icon name={KIND_ICON[asset.kind]}/>}</span>
          <span className="vs-asset-text"><strong>{asset.name}</strong><small>{asset.kind==='image'?asset.width&&asset.height?`${asset.width} × ${asset.height}`:"图片素材":asset.kind==='audio'?`${(asset.duration||0).toFixed(1)} 秒 · 音频`:asset.kind==='video'?`${(asset.duration||0).toFixed(1)} 秒 · 视频`:truncate(asset.text||asset.description,38)}</small></span>
          {count>0&&<span className="vs-asset-uses" title={`已用于 ${count} 个镜头`}>{count}</span>}
        </button>
        <IconButton icon="delete" className="vs-asset-delete" label={`删除资产「${asset.name}」`} onClick={()=>onDelete(asset)} disabled={locked}/>
      </div>;})}
      {!project.assets.length&&<button type="button" className="vs-assets-empty" onClick={()=>file.current?.click()} disabled={pending||locked}><span><Icon name="upload"/></span><strong>把图片拖到这里</strong><small>或添加一段文字，连接到镜头的「使用」或「参考」端口。</small></button>}
      {project.assets.length>0&&!visible.length&&<p className="vs-assets-none">没有匹配的资产</p>}
    </div>
    <div className="vs-drop-veil" aria-hidden="true"><Icon name="upload"/><span>松开即可导入</span></div>
  </aside>;
}
function truncate(value:string,length:number):string{const units=[...value];return units.length>length?units.slice(0,length-1).join('')+'…':value;}
