import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { RenderWatchdog } from './preview-watchdog.ts';

export function shotFrameRange(project:VideoProject,shotId?:string):{start:number;end:number}{let frame=0;for(const id of project.shotOrder){const shot=project.shots.find(s=>s.id===id);if(!shot)continue;const start=frame;frame+=shot.durationFrames;if(id===shotId)return {start,end:frame};}return {start:0,end:frame};}
export function frameShotRange(project:VideoProject,frame:number):{shot?:Shot;start:number;end:number;localFrame:number}{
  const ordered=project.shotOrder.map(id=>project.shots.find(shot=>shot.id===id)).filter((shot):shot is Shot=>Boolean(shot));
  const total=ordered.reduce((sum,shot)=>sum+shot.durationFrames,0),current=Math.max(0,Math.min(Math.max(0,total-1),Math.floor(frame)));
  let start=0;
  for(const shot of ordered){const end=start+shot.durationFrames;if(current<end)return {shot,start,end,localFrame:current-start};start=end;}
  return {start:0,end:0,localFrame:0};
}
export function keyframeNumbers(start:number,end:number):number[]{return [...new Set([start,start+Math.floor(Math.max(0,end-start-1)/2),Math.max(start,end-1)])];}
function FrameThumb({url,frame,onSelect,label}:{url:string;frame:number;onSelect:(frame:number)=>void;label:string}){
  const ref=useRef<HTMLIFrameElement>(null),watchdog=useRef<RenderWatchdog|null>(null),[failed,setFailed]=useState(''),[reload,setReload]=useState(0);const origin=new URL(url).origin;
  const request=()=>{watchdog.current?.arm();ref.current?.contentWindow?.postMessage({type:'video-studio/render',frame},origin);};
  useLayoutEffect(()=>{setFailed('');const guard=new RenderWatchdog(()=>setFailed('画面执行未响应，点击重试'));watchdog.current=guard;guard.arm();const listener=(event:MessageEvent)=>{if(event.source!==ref.current?.contentWindow||event.origin!==origin)return;if(event.data?.type==='video-studio/ready'){guard.acknowledge();request();}if(event.data?.type==='video-studio/frame')guard.acknowledge();if(event.data?.type==='video-studio/error'){guard.acknowledge();setFailed('画面加载失败，点击重试');}};window.addEventListener('message',listener);return()=>{guard.dispose();window.removeEventListener('message',listener);};},[url,frame,origin,reload]);
  return <button className="vs-keyframe" aria-label={`${label} · 第 ${frame} 帧${failed?' · 刷新画面':''}`} onClick={()=>failed?(setFailed(''),setReload(value=>value+1)):onSelect(frame)}>{failed?<span className="vs-keyframe-error">{failed}</span>:<iframe key={reload} ref={ref} src={url} title={`${label}缩略帧`} sandbox="allow-scripts allow-same-origin" tabIndex={-1} onLoad={request}/>}<span>{label} <b>F{frame}</b></span></button>;
}

export function Preview({snapshot,project,selectedShot,controller,focusFrame,focusSerial,busy=false}:{snapshot:StudioSnapshot;project:VideoProject;selectedShot?:Shot;controller:StudioController;focusFrame?:number|null;focusSerial?:number;busy?:boolean}){
  const watchdog=useRef<RenderWatchdog|null>(null);
  const [renderError,setRenderError]=useState(''),[reload,setReload]=useState(0);
  const iframe=useRef<HTMLIFrameElement>(null),audio=useRef<HTMLAudioElement>(null),currentFrame=useRef(0);
  const [ready,setReady]=useState(false),[frame,setFrame]=useState(0),[playing,setPlaying]=useState(false),[sceneId,setSceneId]=useState(''),[showOutput,setShowOutput]=useState(false),[expanded,setExpanded]=useState(false),[jump,setJump]=useState('0'),[audioError,setAudioError]=useState(''),[capturing,setCapturing]=useState(false),[capture,setCapture]=useState<{path:string;url:string}|null>(null);
  const duration=project.shots.reduce((n,s)=>n+s.durationFrames,0),fps=project.target.fps.num/project.target.fps.den;
  currentFrame.current=frame;
  const maxFrame=Math.max(0,duration-1),origin=snapshot.previewUrl?new URL(snapshot.previewUrl).origin:'';
  const range=useMemo(()=>shotFrameRange(project,selectedShot?.id),[project.shotOrder,project.shots,selectedShot?.id]);
  const currentRange=useMemo(()=>frameShotRange(project,frame),[project.shotOrder,project.shots,frame]);
  const marks=useMemo(()=>keyframeNumbers(range.start,range.end),[range.start,range.end]);
  const seek=(value:number)=>{setPlaying(false);setShowOutput(false);setFrame(Math.max(0,Math.min(maxFrame,Math.round(value))));};
  useEffect(()=>{setReady(false);setCapture(null);setRenderError('');},[snapshot.previewUrl,reload]);
  const requestRender=(requestedFrame:number)=>{watchdog.current?.arm();iframe.current?.contentWindow?.postMessage({type:'video-studio/render',frame:requestedFrame},origin);};
  useLayoutEffect(()=>{const guard=new RenderWatchdog(()=>{setRenderError('画面执行未响应，请检查镜头源码或刷新画面。');setReady(false);setPlaying(false);});watchdog.current=guard;if(snapshot.previewUrl&&!showOutput)guard.arm();const listener=(e:MessageEvent)=>{if(e.source!==iframe.current?.contentWindow||e.origin!==origin)return;const data=e.data;if(data?.type==='video-studio/ready'){guard.acknowledge();requestRender(currentFrame.current);}if(data?.type==='video-studio/frame'){guard.acknowledge();setReady(true);setSceneId(typeof data.sceneId==='string'?data.sceneId:'');}if(data?.type==='video-studio/error'){guard.acknowledge();setRenderError(`画面执行错误：${data.message||'渲染失败'}`);setReady(false);setPlaying(false);}};window.addEventListener('message',listener);return()=>{guard.dispose();window.removeEventListener('message',listener);};},[origin,controller,snapshot.previewUrl,reload,showOutput]);
  useEffect(()=>{if(ready&&!showOutput&&!renderError)requestRender(frame);setJump(String(frame));},[frame,ready,origin,showOutput]);
  useEffect(()=>{if(!playing||!ready)return;let animation=0;const start=performance.now(),from=frame;const tick=(now:number)=>{const clock=project.target.audioMode==='mixed'&&snapshot.audioUrl&&audio.current;const next=clock?Math.floor(clock.currentTime*fps):from+Math.floor((now-start)*fps/1000);if(next>=duration){setFrame(maxFrame);setPlaying(false);return;}setFrame(next);animation=requestAnimationFrame(tick);};animation=requestAnimationFrame(tick);return()=>cancelAnimationFrame(animation);},[playing,ready,duration,fps,snapshot.audioUrl,project.target.audioMode]);
  useEffect(()=>{if(!selectedShot)return;seek(range.start);},[selectedShot?.id,range.start]);
  useEffect(()=>{if(focusFrame==null)return;seek(focusFrame);},[focusSerial]);
  useEffect(()=>{if(frame>maxFrame)seek(maxFrame);},[maxFrame]);
  useEffect(()=>{const element=audio.current;if(!element)return;if(playing&&ready&&!showOutput){element.currentTime=Math.min(element.duration||Infinity,frame/fps);void element.play().catch(()=>{setAudioError('声音尚未播放，点击播放后重试。');setPlaying(false);});}else element.pause();return()=>element.pause();},[playing,ready,showOutput,snapshot.audioUrl]);
  useEffect(()=>{const element=audio.current;if(!element)return;const seconds=frame/fps;if(!playing){try{element.currentTime=seconds;}catch{}}},[frame,fps,playing]);
  useEffect(()=>{if(!expanded)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setExpanded(false);};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[expanded]);
  async function reloadScene(){setPlaying(false);setReady(false);try{await window.yingliu?.resetScene?.();setRenderError('');setReload(value=>value+1);}catch(error){setRenderError(error instanceof Error?error.message:'刷新画面失败，请重试。');}}
  async function capturePng(){const capturedFrame=currentFrame.current;setPlaying(false);setCapturing(true);try{await controller.flush();if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);const result=await controller.api.call<{frame?:{path:string;url:string}}>('inspect',{projectId:project.id,shotId:frameShotRange(project,capturedFrame).shot?.id,frame:capturedFrame});if(!result.frame)throw new Error('未获得 PNG 帧');setCapture(result.frame);controller.notify(`第 ${capturedFrame} 帧 PNG 已保存到项目中。`);}catch(error){controller.notify(error instanceof Error?error.message:'导出 PNG 失败');}finally{setCapturing(false);}}
  const localFrame=currentRange.localFrame;
  const output=project.outputs.at(-1),outdated=snapshot.previewRevision!==null&&snapshot.previewRevision!==project.revision;
  const disabled=!ready||showOutput;
  return <div className={`vs-preview ${expanded?'is-expanded':''}`}>
    <div className="vs-preview-heading"><span data-testid="current-shot-heading" data-shot-id={currentRange.shot?.id}>{currentRange.shot?`「${currentRange.shot.title}」· 帧 [${currentRange.start}, ${currentRange.end})`:'整片逐帧查看'}</span><button aria-label={expanded?'关闭大预览':'打开大预览'} onClick={()=>setExpanded(!expanded)}>{expanded?'收起 ✕':'大预览 ↗'}</button></div>
    <div className="vs-preview-screen" style={{'--vs-preview-ratio':`${project.target.width}/${project.target.height}`} as CSSProperties}>
      {showOutput&&output?.url?<video src={output.url} controls className="vs-output-video"/>:snapshot.previewUrl?<iframe key={reload} ref={iframe} src={snapshot.previewUrl} title="影片画面预览" sandbox="allow-scripts allow-same-origin" onLoad={()=>requestRender(currentFrame.current)}/>:<div className="vs-preview-empty"><strong>画面从这里开始</strong><p>生成画面后，点击「预览」。<br/>手动编辑的镜头也可以直接预览。</p></div>}
      {renderError&&!showOutput&&<div className="vs-render-error" role="alert"><strong>{renderError}</strong><button onClick={()=>void reloadScene()}>重新加载画面</button></div>}{snapshot.previewUrl&&!ready&&!renderError&&!showOutput&&<span className="vs-preview-badge">正在等待画面执行…</span>}{outdated&&<span className="vs-preview-badge">参数已更新 · 刷新预览</span>}
    </div>
    {snapshot.audioUrl&&project.target.audioMode==='mixed'&&<audio ref={audio} src={snapshot.audioUrl} preload="auto" onError={()=>setAudioError('混音预览加载失败，可刷新预览后重试。')}/>}
    <div className="vs-player"><button aria-label={playing?'暂停':'播放'} disabled={disabled} onClick={()=>{setAudioError('');if(frame>=maxFrame)setFrame(0);setPlaying(v=>!v);}}>{playing?'Ⅱ':'▶'}</button><button aria-label="上一帧" disabled={disabled||frame===0} onClick={()=>seek(frame-1)}>◀|</button><button aria-label="下一帧" disabled={disabled||frame===maxFrame} onClick={()=>seek(frame+1)}>&gt;|</button><span>{(frame/fps).toFixed(3)}s</span><input type="range" aria-label="影片播放位置" min="0" max={maxFrame} step="1" value={frame} disabled={disabled} onChange={e=>seek(Number(e.target.value))}/><span>{(duration/fps).toFixed(3)}s</span></div>
    <div className="vs-frame-jump"><span>F<span data-testid="current-frame">{frame}</span> / {maxFrame}</span>{currentRange.shot&&<span data-testid="current-shot-local-frame">镜头 F{localFrame} · {(localFrame/fps).toFixed(3)}s</span>}<label>跳转帧 <input aria-label="跳转帧" type="number" min="0" max={maxFrame} value={jump} disabled={disabled} onChange={e=>setJump(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&Number.isFinite(Number(jump)))seek(Number(jump));}}/></label><button disabled={disabled||!Number.isFinite(Number(jump))} onClick={()=>seek(Number(jump))}>定位</button><button disabled={disabled||busy||capturing} onClick={()=>void capturePng()}>{capturing?'正在保存…':'导出当前帧 PNG'}</button><span>{snapshot.audioUrl&&project.target.audioMode==='mixed'?'声音已同步':'无声预览'}</span></div>{capture&&<div className="vs-captured-frame"><a href={capture.url} target="_blank" rel="noreferrer">查看已保存 PNG ↗</a><button onClick={()=>void controller.action('reveal',{path:capture.path})}>打开 PNG 文件</button></div>}
    {snapshot.previewUrl&&ready&&!showOutput&&<><div className="vs-eyebrow" data-testid="keyframe-scope">{selectedShot?`选中「${selectedShot.title}」的关键帧`:'全片关键帧'}</div><div className="vs-keyframes" aria-label="镜头关键帧">{marks.map((number,index)=><FrameThumb key={`${snapshot.previewUrl}:${number}`} url={snapshot.previewUrl!} frame={number} label={index===0?'首帧':index===marks.length-1?'末帧':'中帧'} onSelect={seek}/>)}</div></>}
    {audioError&&<p className="vs-inline-error">{audioError}</p>}
    <div className="vs-preview-foot"><span>{showOutput?'已导出 MP4':sceneId?project.shots.find(s=>s.id===sceneId)?.title||sceneId:'逐帧预览'}</span>{output?.url&&<button onClick={()=>{setPlaying(false);setReady(false);setShowOutput(value=>!value);}}>{showOutput?'返回逐帧':'播放成片'}</button>}{output&&<button onClick={()=>void controller.action('reveal',{path:output.path})}>打开成片 →</button>}</div>
  </div>;
}
