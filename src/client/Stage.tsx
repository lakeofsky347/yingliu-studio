import { useEffect, useRef, type RefObject } from 'react';
import type { Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { StudioController, StudioState } from './controller.ts';
import type { LiteGraphEditor } from './graph-adapter.ts';
import { Button, Icon, IconButton } from './icons.tsx';
import { targetLabel } from './output-settings.tsx';
import { Preview } from './Preview.tsx';
import type { Playhead } from './playhead-store.ts';

export type StageMode='monitor'|'canvas'|'split';
export type StageLayout='wide'|'medium'|'narrow';

export function Stage({project,snapshot,state,controller,playhead,layout,stageMode,onStageMode,assetsOpen,onToggleAssets,onOutputSettings,duration,selectedShot,locked,busy,graphCheck,canvasRef,minimapRef,graphRef,zoom,onAddShot,onRefreshPreview,onConnectOrder,ordered,wordOpen,onWordOpen,editScope,onEditScope,instruction,onInstruction,onModify,modelConfigured}:{
  project:VideoProject;snapshot:StudioSnapshot;state:StudioState;controller:StudioController;layout:StageLayout;
  playhead:Playhead;
  stageMode:StageMode;onStageMode:(mode:StageMode)=>void;assetsOpen:boolean;onToggleAssets:()=>void;onOutputSettings:()=>void;
  duration:number;selectedShot?:Shot;locked:boolean;busy:boolean;graphCheck:{ok:boolean;errors:string[]}|null;
  canvasRef:RefObject<HTMLCanvasElement>;minimapRef:RefObject<HTMLCanvasElement>;graphRef:RefObject<LiteGraphEditor|null>;zoom:number;
  onAddShot:()=>void;onRefreshPreview:()=>void;onConnectOrder:(ids:string[])=>void;ordered:Shot[];
  wordOpen:boolean;onWordOpen:(open:boolean)=>void;editScope:'shot'|'film';onEditScope:(scope:'shot'|'film')=>void;
  instruction:string;onInstruction:(value:string)=>void;onModify:()=>void;modelConfigured:boolean;
}){
  const wordRef=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{if(wordOpen)requestAnimationFrame(()=>wordRef.current?.focus());},[wordOpen]);
  const canvasVisible=stageMode!=='monitor';
  const durationOff=Math.abs(duration-project.targetDuration)>Math.max(1,project.targetDuration*.1);
  return <section className="vs-stage" data-mode={stageMode} aria-label="舞台">
    <div className="vs-stage-toolbar">
      <div className="vs-stage-left">
        {layout!=='wide'&&<IconButton icon="sidebar" label="资产库" active={assetsOpen} onClick={onToggleAssets}/>}
        <div className="vs-segmented vs-stage-modes" role="radiogroup" aria-label="舞台视图">
          {([['monitor','monitor',"监视器"],['canvas','graph',"分镜画布"],['split','split',"分栏"]] as const).map(([mode,icon,label])=>(layout==='narrow'&&mode==='split')?null:<button type="button" role="radio" key={mode} aria-checked={stageMode===mode} className={stageMode===mode?'is-active':''} title={label} aria-label={label} onClick={()=>onStageMode(mode)}><Icon name={icon}/><span>{label}</span></button>)}
        </div>
        <button type="button" className="vs-format-chip" aria-label="打开输出设定" title="输出设定" onClick={onOutputSettings}>{targetLabel(project.target)}</button>
        <span className={`vs-duration ${durationOff?'is-off':''}`} title={`/ 目标 ${project.targetDuration} 秒`}><strong>{duration.toFixed(1)}s</strong><small>/ {project.targetDuration}s</small></span>
      </div>
      <div className="vs-stage-right">
        <IconButton icon="undo" label="撤销 · Ctrl/Cmd Z" disabled={!state.canUndo||locked} onClick={controller.undo}/>
        <IconButton icon="redo" label="重做 · Ctrl/Cmd Shift Z" disabled={!state.canRedo||locked} onClick={controller.redo}/>
        {canvasVisible&&<><span className="vs-separator"/>
          <IconButton icon="group" label="选中节点分组" disabled={locked} onClick={()=>graphRef.current?.groupSelection()}/>
          <IconButton icon="grid" label="整理画布" disabled={locked} onClick={()=>graphRef.current?.arrange()}/>
        </>}
        <Button icon="plus" size="sm" disabled={locked} onClick={onAddShot} title="添加镜头" aria-label="添加镜头">镜头</Button>
        <span className="vs-separator"/>
        <IconButton icon="refresh" label="刷新预览" title="检查资源并刷新预览" disabled={busy||locked||state.previewing||state.sourceDraft||!graphCheck?.ok} onClick={onRefreshPreview}/>
        <button type="button" className={`vs-word-trigger ${wordOpen?'is-active':''}`} aria-expanded={wordOpen} onClick={()=>onWordOpen(!wordOpen)} title="用文字修改 · Ctrl / ⌘ K" aria-label="用文字修改"><Icon name="spark"/><span>用文字修改</span><kbd>⌘K</kbd></button>
      </div>
    </div>
    <div className="vs-stage-body">
      <div className="vs-stage-monitor" aria-hidden={stageMode==='canvas'||undefined}>
        <Preview key={project.id} snapshot={snapshot} project={project} selectedShot={selectedShot} controller={controller} transport={playhead} focusFrame={state.focusFrame} focusSerial={state.focusSerial} busy={busy} syncing={state.saving||state.dirty||state.previewing} preparePreview={graphCheck?.ok&&!state.sourceDraft&&!state.conflict?()=>void controller.action('preview',{prepareOnly:true}):undefined}/>
      </div>
      <div className="vs-stage-canvas" aria-hidden={stageMode==='monitor'||undefined}>
        <div className="vs-graph-shell"><canvas ref={canvasRef}/>
          <div className="vs-graph-legend"><span><i className="asset"/>实际使用</span><span><i className="reference"/>仅供参考</span><span><i className="shot"/>播放顺序</span></div>
          <div className="vs-graph-hud-right">
            <div className="vs-graph-navigation" role="toolbar" aria-label="画布缩放">
              <button type="button" aria-label="缩小画布" onClick={()=>graphRef.current?.zoom(zoom/1.2)}><Icon name="minus"/></button>
              <button type="button" className="vs-zoom-value" aria-label="画布 100%" onClick={()=>graphRef.current?.zoom(1)}>{Math.round(zoom*100)}%</button>
              <button type="button" aria-label="放大画布" onClick={()=>graphRef.current?.zoom(zoom*1.2)}><Icon name="plus"/></button>
              <span className="vs-separator"/>
              <button type="button" aria-label="聚焦选中" title="聚焦选中" disabled={!state.selected} onClick={()=>graphRef.current?.focus(state.selected||undefined)}><Icon name="focus"/></button>
              <button type="button" aria-label="全图概览" title="全图概览" onClick={()=>graphRef.current?.fit()}><Icon name="fit"/></button>
              <button type="button" aria-label="整理画布" title="整理画布" disabled={locked} onClick={()=>graphRef.current?.arrange()}><Icon name="grid"/></button>
            </div>
            <div className="vs-graph-minimap" aria-hidden="true" title="拖动或点击定位画布">
              <canvas ref={minimapRef}/>
            </div>
          </div>
          {graphCheck&&!graphCheck.ok&&<div className="vs-chain-note" role="status"><Icon name="warning"/><span><strong>主链待连接</strong>{graphCheck.errors[0]}</span><Button size="sm" disabled={locked} onClick={()=>onConnectOrder(ordered.map(s=>s.id))}>按时间线顺序连接</Button></div>}
        </div>
      </div>
      {wordOpen&&<div className="vs-word-panel" role="dialog" aria-label="用文字修改">
        <div className="vs-word-head">
          <div className="vs-segmented is-compact" role="radiogroup" aria-label="修改范围">
            <button type="button" role="radio" aria-checked={editScope==='shot'} className={editScope==='shot'?'is-active':''} disabled={!selectedShot} onClick={()=>onEditScope('shot')}>当前镜头</button>
            <button type="button" role="radio" aria-checked={editScope==='film'} className={editScope==='film'?'is-active':''} onClick={()=>onEditScope('film')}>整部影片</button>
          </div>
          <IconButton icon="close" label="关闭" onClick={()=>onWordOpen(false)}/>
        </div>
        <h3>{editScope==='shot'&&selectedShot?`修改「${selectedShot.title}」`:"继续打磨整部影片"}</h3>
        <p>修改请求和结果会保存到创作对话。</p>
        <textarea ref={wordRef} rows={3} aria-label="修改指令" placeholder="例如：标题从左侧滑入，图片缓慢放大，整体改成奶油色。" value={instruction} onChange={e=>onInstruction(e.target.value)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();onModify();}if(e.key==='Escape'){e.preventDefault();onWordOpen(false);}}}/>
        <div className="vs-word-foot"><small>{modelConfigured?"Ctrl / ⌘ Enter 提交":"配置模型后即可生成。"}</small><Button variant="primary" icon="spark" disabled={busy||!instruction.trim()||(editScope==='shot'&&!selectedShot)} onClick={onModify}>{modelConfigured?(editScope==='shot'?'修改这个镜头':'修改整部影片'):'配置创作模型'}</Button></div>
      </div>}
    </div>
  </section>;
}
