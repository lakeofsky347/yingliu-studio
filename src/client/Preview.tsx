import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { RenderWatchdog } from './preview-watchdog.ts';
import type { Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { Icon } from './icons.tsx';
import { Popover } from './Feedback.tsx';
import { timecode, type Playhead } from './playhead-store.ts';

export function shotFrameRange(project:VideoProject,shotId?:string):{start:number;end:number}{let frame=0;for(const id of project.shotOrder){const shot=project.shots.find(s=>s.id===id);if(!shot)continue;const start=frame;frame+=shot.durationFrames;if(id===shotId)return {start,end:frame};}return {start:0,end:frame};}
export function frameShotRange(project:VideoProject,frame:number):{shot?:Shot;start:number;end:number;localFrame:number}{
  const ordered=project.shotOrder.map(id=>project.shots.find(shot=>shot.id===id)).filter((shot):shot is Shot=>Boolean(shot));
  const total=ordered.reduce((sum,shot)=>sum+shot.durationFrames,0),current=Math.max(0,Math.min(Math.max(0,total-1),Math.floor(frame)));
  let start=0;
  for(const shot of ordered){const end=start+shot.durationFrames;if(current<end)return {shot,start,end,localFrame:current-start};start=end;}
  return {start:0,end:0,localFrame:0};
}
export function keyframeNumbers(start:number,end:number):number[]{return [...new Set([start,start+Math.floor(Math.max(0,end-start-1)/2),Math.max(start,end-1)])];}
/** Next preview frame. A negative animation-clock delta stays put instead of requesting frame -1. */
export function previewPlaybackFrame(from:number,elapsedMs:number,fps:number,mediaTime:number|null,duration:number):{frame:number;ended:boolean}{
  const maxFrame=Math.max(0,duration-1),origin=Number.isFinite(from)?Math.max(0,Math.min(maxFrame,Math.trunc(from))):0;
  const raw=mediaTime==null?origin+Math.floor(Math.max(0,elapsedMs)*fps/1000):Math.floor(mediaTime*fps);
  if(!Number.isFinite(raw)||raw>=Math.max(0,duration))return {frame:maxFrame,ended:true};
  return {frame:Math.max(0,raw),ended:false};
}
function FrameThumb({url,frame,active,onSelect,label,failed}:{url?:string;frame:number;active:boolean;onSelect:(frame:number)=>void;label:string;failed:boolean}){
  const [imageFailed,setImageFailed]=useState(false);
  return <button className={`vs-keyframe ${active?'is-current':''}`} aria-label={`${label} · 第 ${frame} 帧`} onClick={()=>onSelect(frame)}>{url&&!imageFailed?<img src={url} alt={`${label}缩略帧`} onError={()=>setImageFailed(true)}/>:<div className="vs-keyframe-placeholder">{failed||imageFailed?"画面加载失败":"正在生成缩略帧…"}</div>}<span>{label} <b>F{frame}</b></span></button>;
}

export function Preview({snapshot,project,selectedShot,controller,focusFrame,focusSerial,busy=false,syncing=false,preparePreview,transport}:{snapshot:StudioSnapshot;project:VideoProject;selectedShot?:Shot;controller:StudioController;focusFrame?:number|null;focusSerial?:number;busy?:boolean;syncing?:boolean;preparePreview?:()=>void;transport?:Playhead}){
  const preview=useRef<HTMLDivElement>(null),iframe=useRef<HTMLIFrameElement>(null),audio=useRef<HTMLAudioElement>(null),currentFrame=useRef(0),handledSpace=useRef(false);
  const [readyKey,setReadyKey]=useState(''),[frame,setFrame]=useState(0),[playing,setPlaying]=useState(false),[sceneId,setSceneId]=useState(''),[showOutput,setShowOutput]=useState(false),[expanded,setExpanded]=useState(false),[jump,setJump]=useState('0'),[jumping,setJumping]=useState(false),[audioError,setAudioError]=useState(''),[capturing,setCapturing]=useState(false),[capture,setCapture]=useState<{path:string;url:string}|null>(null),[previewError,setPreviewError]=useState(''),[reload,setReload]=useState(0);
  const duration=project.shots.reduce((n,s)=>n+s.durationFrames,0),fps=project.target.fps.num/project.target.fps.den;
  currentFrame.current=frame;
  const maxFrame=Math.max(0,duration-1),origin=snapshot.previewUrl?new URL(snapshot.previewUrl).origin:'';
  const previewKey=JSON.stringify([project.id,snapshot.previewUrl,snapshot.previewRevision,reload,showOutput]),ready=!!snapshot.previewUrl&&readyKey===previewKey;
  const requestFrame=useRef<(frame:number)=>void>(()=>{});
  const previewUrl=snapshot.previewUrl??undefined;
  const range=useMemo(()=>shotFrameRange(project,selectedShot?.id),[project.shotOrder,project.shots,selectedShot?.id]);
  const currentRange=useMemo(()=>frameShotRange(project,frame),[project.shotOrder,project.shots,frame]);
  const marks=useMemo(()=>keyframeNumbers(range.start,range.end),[range.start,range.end]);
  const boundaries=useMemo(()=>{let at=0;const values:number[]=[];for(const id of project.shotOrder){const shot=project.shots.find(s=>s.id===id);if(!shot)continue;at+=shot.durationFrames;if(at<duration)values.push(at);}return values;},[project.shotOrder,project.shots,duration]);
  const thumbnailKey=JSON.stringify([snapshot.previewUrl,snapshot.previewRevision,marks]);
  const [thumbnails,setThumbnails]=useState<{key:string;urls:Record<number,string>;failed:boolean}>({key:'',urls:{},failed:false});
  useEffect(()=>{
    if(!snapshot.previewUrl||!ready||showOutput||busy||!duration||snapshot.previewRevision!==project.revision)return;
    let active=true;const timer=setTimeout(()=>{
      void controller.api.call<{frames:{frame:number;url:string}[]}>('thumbnails',{projectId:project.id,expectedRevision:snapshot.previewRevision,frames:marks}).then(result=>{if(active)setThumbnails({key:thumbnailKey,urls:Object.fromEntries(result.frames.map(capture=>[capture.frame,capture.url])),failed:false});}).catch(()=>{if(active)setThumbnails({key:thumbnailKey,urls:{},failed:true});});
    },150);
    return()=>{active=false;clearTimeout(timer);};
  },[thumbnailKey,ready,showOutput,busy,controller,project.id,project.revision,snapshot.previewRevision,duration]);
  const seek=(value:number)=>{setPlaying(false);setShowOutput(false);setFrame(Math.max(0,Math.min(maxFrame,Math.round(value))));};
  const togglePlay=()=>{setAudioError('');if(currentFrame.current>=maxFrame)setFrame(0);setPlaying(value=>!value);};
  useLayoutEffect(()=>{
    setCapture(null);setPlaying(false);setSceneId('');setPreviewError('');
    const target=iframe.current?.contentWindow;
    if(!target||!previewUrl||showOutput)return;
    let initialized=false;
    const watchdog=new RenderWatchdog(()=>{
      setReadyKey('');setPlaying(false);
      setPreviewError('画面执行未响应，请检查镜头源码或刷新画面。');
    });
    const send=(value:number)=>{
      if(!initialized)return;
      watchdog.arm();
      target.postMessage({type:'video-studio/render',frame:value},origin);
    };
    requestFrame.current=send;
    const listener=(event:MessageEvent)=>{
      if(event.source!==target||event.origin!==origin)return;
      const data=event.data;
      if(data?.type==='video-studio/ready'){initialized=true;watchdog.acknowledge();send(currentFrame.current);}
      if(data?.type==='video-studio/frame'&&initialized&&Number.isSafeInteger(data.frame)){
        watchdog.acknowledge();setReadyKey(previewKey);setPreviewError('');setSceneId(typeof data.sceneId==='string'?data.sceneId:'');
      }
      if(data?.type==='video-studio/error'){
        watchdog.acknowledge();setReadyKey('');setPlaying(false);setPreviewError('画面执行错误：'+String(data.message||'渲染失败'));
      }
    };
    window.addEventListener('message',listener);
    watchdog.arm();
    return()=>{watchdog.dispose();requestFrame.current=()=>{};window.removeEventListener('message',listener);};
  },[previewKey,previewUrl,origin]);
  useEffect(()=>{if(ready)requestFrame.current(frame);setJump(String(frame));},[frame,ready]);
  useEffect(()=>{if(!playing||!ready)return;let animation=0;const start=performance.now(),from=frame;const tick=(now:number)=>{const mediaTime=project.target.audioMode==='mixed'&&snapshot.audioUrl&&audio.current&&Number.isFinite(audio.current.currentTime)?audio.current.currentTime:null;const step=previewPlaybackFrame(from,now-start,fps,mediaTime,duration);setFrame(step.frame);if(step.ended){setPlaying(false);return;}animation=requestAnimationFrame(tick);};animation=requestAnimationFrame(tick);return()=>cancelAnimationFrame(animation);},[playing,ready,duration,fps,snapshot.audioUrl,project.target.audioMode]);
  useEffect(()=>{if(!selectedShot)return;seek(range.start);},[selectedShot?.id,range.start]);
  useEffect(()=>{if(focusFrame==null)return;seek(focusFrame);},[focusSerial]);
  useEffect(()=>{if(frame>maxFrame)seek(maxFrame);},[maxFrame]);
  useEffect(()=>{const element=audio.current;if(!element)return;if(playing&&ready&&!showOutput){element.currentTime=Math.min(element.duration||Infinity,frame/fps);void element.play().catch(()=>{setAudioError('声音尚未播放，点击播放后重试。');setPlaying(false);});}else element.pause();return()=>element.pause();},[playing,ready,showOutput,snapshot.audioUrl]);
  useEffect(()=>{const element=audio.current;if(!element)return;const seconds=frame/fps;if(!playing){try{element.currentTime=seconds;}catch{}}},[frame,fps,playing]);
  // Other surfaces (timeline, canvas, global shortcuts) drive the monitor through the playhead channel.
  useEffect(()=>{transport?.publish(frame,duration,playing);},[transport,frame,duration,playing]);
  useEffect(()=>transport?.onSeek(value=>seek(value)),[transport,maxFrame]);
  useEffect(()=>transport?.onToggle(()=>{if(!ready||showOutput)return false;togglePlay();return true;}),[transport,ready,showOutput,maxFrame]);
  useEffect(()=>{
    const studio=preview.current?.closest<HTMLElement>('.vs-studio');
    if(!studio)return;
    const onKey=(event:KeyboardEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(event.defaultPrevented||!target||target.closest('[role=dialog]'))return;
      if(expanded&&event.key==='Escape'&&preview.current?.contains(target)){
        event.preventDefault();setExpanded(false);return;
      }
      if(target.closest('input, textarea, select, [contenteditable=true], canvas'))return;
      if(event.key===' '||event.code==='Space'){
        // Keyboard users activating a focused control keep native Space; pointer-focused controls do not swallow playback.
        const control=target.closest('button, a, summary, [role=tab]');
        if(control&&control!==pointerControl)return;
        event.preventDefault();handledSpace.current=true;if(event.repeat||!ready||showOutput)return;
        togglePlay();
      }
      if(target.closest('[data-keyboard-owner]'))return;
      if(event.altKey&&event.key==='ArrowLeft'){event.preventDefault();seek(currentFrame.current-1);}
      if(event.altKey&&event.key==='ArrowRight'){event.preventDefault();seek(currentFrame.current+1);}
    };
    // Controls focused by a pointer click do not own Space; controls reached by keyboard keep native activation.
    let pointerControl:Element|null=null;
    const onPointer=(event:PointerEvent)=>{pointerControl=event.target instanceof Element?event.target.closest('button, a, summary, [role=tab]'):null;};
    const onTab=(event:KeyboardEvent)=>{if(event.key==='Tab')pointerControl=null;};
    studio.addEventListener('pointerdown',onPointer,true);studio.addEventListener('keydown',onTab,true);
    const onKeyUp=(event:KeyboardEvent)=>{if((event.key===' '||event.code==='Space')&&handledSpace.current){handledSpace.current=false;event.preventDefault();}};
    studio.addEventListener('keydown',onKey);studio.addEventListener('keyup',onKeyUp);return()=>{studio.removeEventListener('keydown',onKey);studio.removeEventListener('keyup',onKeyUp);studio.removeEventListener('pointerdown',onPointer,true);studio.removeEventListener('keydown',onTab,true);};
  },[ready,showOutput,maxFrame,expanded]);
  async function reloadScene(){
    setPlaying(false);
    try{
      await window.yingliu?.resetScene?.();
      setReadyKey('');setPreviewError('');setReload(value=>value+1);
    }catch(error){
      setPreviewError(error instanceof Error?error.message:'刷新画面失败，请重试。');
    }
  }
  async function capturePng(){const capturedFrame=currentFrame.current;setPlaying(false);setCapturing(true);try{await controller.flush();if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);const result=await controller.api.call<{frame?:{path:string;url:string}}>('inspect',{projectId:project.id,shotId:frameShotRange(project,capturedFrame).shot?.id,frame:capturedFrame});if(!result.frame)throw new Error('未获得 PNG 帧');setCapture(result.frame);controller.notify(`第 ${capturedFrame} 帧 PNG 已保存到项目中。`);}catch(error){controller.notify(error instanceof Error?error.message:'导出 PNG 失败');}finally{setCapturing(false);}}
  const localFrame=currentRange.localFrame;
  const output=project.outputs.at(-1),outdated=snapshot.previewRevision!==null&&snapshot.previewRevision!==project.revision;
  const disabled=!ready||showOutput;
  const mixed=!!snapshot.audioUrl&&project.target.audioMode==='mixed';
  const commitJump=()=>{const value=Number(jump);if(jump.trim()!==''&&Number.isFinite(value))seek(value);setJumping(false);};
  const shotLabel=showOutput?"已导出 MP4":currentRange.shot?`「${currentRange.shot.title}」· 帧 [${currentRange.start}, ${currentRange.end})`:"整片逐帧查看";
  return <div ref={preview} className={`vs-preview vs-monitor ${expanded?'is-expanded':''} ${playing?'is-playing':''}`}>
    <div className={`vs-preview-screen ${ready||showOutput?'is-ready':''}`} style={{'--vs-preview-ratio':`${project.target.width}/${project.target.height}`,'--vs-ar':String(project.target.width/Math.max(1,project.target.height))} as CSSProperties}>
      <div className="vs-preview-frame">
        {showOutput&&output?.url?<video src={output.url} controls className="vs-output-video"/>:snapshot.previewUrl?<iframe key={previewKey} ref={iframe} src={previewUrl} title="影片画面预览" sandbox="allow-scripts allow-same-origin"/>:<div className="vs-preview-empty"><span className="vs-preview-empty-icon"><Icon name="film"/></span><strong>尚未准备预览</strong>{preparePreview?<button type="button" disabled={busy||syncing} onClick={preparePreview}>准备预览</button>:<p>连接分镜主链后即可预览。</p>}</div>}
        {snapshot.previewUrl&&!ready&&!showOutput&&!previewError&&<span className="vs-preview-loading" aria-hidden="true"/>}
      <div className="vs-monitor-hud">
        <span className="vs-hud-chip" data-testid="current-shot-heading" data-shot-id={currentRange.shot?.id}>{shotLabel}</span>
        {(outdated||syncing)&&<span className="vs-preview-badge"><i/>正在同步最新修改…</span>}
      </div>
      <button type="button" className="vs-monitor-expand" aria-label={expanded?"关闭大预览":"打开大预览"} title={expanded?"收起 · Esc":"大预览"} onClick={()=>setExpanded(!expanded)}><Icon name={expanded?'collapse':'expand'}/></button>
      </div>
    </div>
    {snapshot.audioUrl&&project.target.audioMode==='mixed'&&<audio ref={audio} src={snapshot.audioUrl} preload="auto" onError={()=>setAudioError('混音预览加载失败，可刷新预览后重试。')}/>}
    <div className="vs-player">
      <button type="button" className="vs-play" aria-label={playing?"暂停":"播放"} title={playing?"暂停 · 空格":"播放 · 空格"} disabled={disabled} onClick={togglePlay}><Icon name={playing?'pause':'play'}/></button>
      <button type="button" className="vs-step" aria-label="上一帧" title="上一帧 · Alt ←" disabled={disabled||frame===0} onClick={()=>seek(frame-1)}><Icon name="stepBack"/></button>
      <button type="button" className="vs-step" aria-label="下一帧" title="下一帧 · Alt →" disabled={disabled||frame===maxFrame} onClick={()=>seek(frame+1)}><Icon name="stepForward"/></button>
      <span className="vs-timecode" title={`${(frame/fps).toFixed(3)} 秒`}><strong>{timecode(frame,fps)}</strong><small>{timecode(duration,fps)}</small></span>
      <div className="vs-scrub" style={{'--vs-scrub':`${maxFrame?frame/maxFrame*100:0}%`} as CSSProperties}>
        <input type="range" aria-label="影片播放位置" min="0" max={maxFrame} step="1" value={frame} disabled={disabled} onChange={e=>seek(Number(e.target.value))}/>
        <span className="vs-scrub-marks" aria-hidden="true">{boundaries.map(at=><i key={at} style={{left:`${maxFrame?at/maxFrame*100:0}%`}}/>)}</span>
      </div>
      {jumping?<input className="vs-frame-input" autoFocus aria-label="跳转帧" type="number" min="0" max={maxFrame} value={jump} onChange={e=>setJump(e.target.value)} onBlur={commitJump} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitJump();}if(e.key==='Escape'){e.preventDefault();setJump(String(frame));setJumping(false);}}}/>
        :<button type="button" className="vs-frame-readout" disabled={disabled} aria-label="跳转到指定帧" title="点击跳转到指定帧" onClick={()=>{setPlaying(false);setJumping(true);}}>F<span data-testid="current-frame">{frame}</span><small>/ {maxFrame}</small></button>}
      <span className={`vs-audio-state ${mixed?'is-on':''}`} title={mixed?"声音已同步":"无声预览"}><Icon name={mixed?'volume':'mute'}/></span>
      <Popover label="更多预览操作" trigger={({open,toggle,ref})=><button type="button" ref={ref} className="vs-iconbutton" aria-label="更多预览操作" aria-expanded={open} onClick={toggle}><Icon name="more"/></button>}>
        {close=><div className="vs-menu">
          <button type="button" disabled={disabled||busy||capturing} onClick={()=>{close();void capturePng();}}><Icon name="camera"/><span>{capturing?"正在保存…":"导出当前帧 PNG"}</span></button>
          {output?.url&&<button type="button" onClick={()=>{close();setPlaying(false);setReadyKey('');setShowOutput(value=>!value);}}><Icon name={showOutput?'film':'play'}/><span>{showOutput?"返回逐帧":"播放成片"}</span></button>}
          {output&&<button type="button" onClick={()=>{close();void controller.action('reveal',{path:output.path});}}><Icon name="external"/><span>打开成片 →</span></button>}
          <button type="button" onClick={()=>{close();void reloadScene();}}><Icon name="refresh"/><span>重新载入画面</span></button>
          <div className="vs-menu-note">{currentRange.shot?`镜头 F${localFrame} · ${(localFrame/fps).toFixed(3)}s`:''}{sceneId&&!showOutput?` · ${project.shots.find(s=>s.id===sceneId)?.title||sceneId}`:''}</div>
        </div>}
      </Popover>
    </div>
    {capture&&<div className="vs-captured-frame"><Icon name="check"/><a href={capture.url} target="_blank" rel="noreferrer">查看已保存 PNG ↗</a><button type="button" onClick={()=>void controller.action('reveal',{path:capture.path})}>打开 PNG 文件</button><button type="button" className="vs-iconbutton" aria-label="关闭提示" onClick={()=>setCapture(null)}><Icon name="close"/></button></div>}
    {snapshot.previewUrl&&ready&&!showOutput&&<div className="vs-keyframe-strip"><div className="vs-eyebrow" data-testid="keyframe-scope">{selectedShot?`选中「${selectedShot.title}」的关键帧`:"全片关键帧"}</div><div className="vs-keyframes" aria-label="镜头关键帧">{marks.map((number,index)=><FrameThumb key={`${thumbnailKey}:${number}`} url={thumbnails.key===thumbnailKey?thumbnails.urls[number]:undefined} failed={thumbnails.key===thumbnailKey&&thumbnails.failed} frame={number} active={Math.abs(frame-number)<=2} label={index===0?"首帧":index===marks.length-1?"末帧":"中帧"} onSelect={seek}/>)}</div></div>}
    {audioError&&<p className="vs-inline-error">{audioError}</p>}
    {previewError&&<p className="vs-inline-error" role="alert">{previewError}<button onClick={()=>void reloadScene()}>重新加载画面</button></p>}
  </div>;
}
