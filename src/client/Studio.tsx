import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject, type ReactNode } from 'react';
import { compileSpec, deleteAsset, deleteShot, duplicateShot, reorderShots, specMarkdown, validateGraph } from '../core/index.ts';
import type { Asset, Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import { StudioController, type EditUndo } from './controller.ts';
import { LiteGraphEditor, type GraphRemoval } from './graph-adapter.ts';
import { OutputSettings } from './output-settings.tsx';
import { AudioPanel } from './AudioPanel.tsx';
import { TaskPanel, HistoryPanel } from './TaskPanel.tsx';
import { ExportPanel } from './ExportPanel.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { WorkflowPanel } from './WorkflowPanel.tsx';
import { SourceEditor } from './SourceEditor.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { addPlacedShot } from './project-ui.ts';
import { Button, Icon, IconButton } from './icons.tsx';
import { Dialog } from './Dialog.tsx';
import { ConfirmationScope, ConfirmHost, Toasts, useCancelConfirmation, useConfirmAction } from './Feedback.tsx';
import { createToastStore } from './toast-store.ts';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';
import { Stage, type StageLayout, type StageMode } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { createPlayhead } from './playhead-store.ts';
import { BottomDrawer, type DrawerTab } from './BottomDrawer.tsx';
import { StudioHeader, taskLabel, type MenuItem, type StageId, type StepInfo } from './StudioHeader.tsx';
import { Field } from './ui.tsx';

const drawerTabs = [
  {id:'agent',label:'智能体',icon:'spark'},
  {id:'media',label:'模型与素材生成',icon:'image'},
  {id:'workflow',label:'协作制作',icon:'users'},
  {id:'audio',label:'声音与配音',icon:'music'},
  {id:'source',label:'前端源码',icon:'code'},
  {id:'spec',label:'制作要求',icon:'doc'},
  {id:'history',label:'修改历史',icon:'history'},
  {id:'tasks',label:'任务记录',icon:'tasks'},
  {id:'exports',label:'导出成片',icon:'film'},
  {id:'environment',label:'运行环境',icon:'settings'},
] as const satisfies readonly DrawerTab<string>[];
type PanelTab = typeof drawerTabs[number]['id'];
type Pane = 'properties'|'assets'|'panels';

export interface StudioProps {
  controller: StudioController;
  onHome: () => void;
  onNew: () => void;
  onOpen: () => void;
  onConfigure: () => void;
  modelConfigured: boolean;
  externallyBusy: boolean;
}

function useStudioLayout(ref:RefObject<HTMLElement>):StageLayout {
  const [layout,setLayout]=useState<StageLayout>('wide');
  useLayoutEffect(()=>{
    const element=ref.current;
    if(!element||typeof ResizeObserver==='undefined')return;
    const measure=()=>{
      const width=element.getBoundingClientRect().width;
      setLayout(width<780?'narrow':width<1180?'medium':'wide');
    };
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(element);
    return()=>observer.disconnect();
  },[ref]);
  return layout;
}

export function Studio(props:StudioProps){
  return <ConfirmationScope><Workbench {...props}/></ConfirmationScope>;
}

function Workbench({controller,onHome,onNew,onOpen,onConfigure,modelConfigured,externallyBusy}:StudioProps){
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const snapshot=state.snapshot,project=snapshot?.project,task=snapshot?.task;
  const running=task?.status==='running',busy=externallyBusy||state.pending||running;
  const locked=externallyBusy||state.pending||state.conflict||running&&task.kind!=='export';
  const lockReason=state.conflict?'请先处理保存冲突':externallyBusy?'创作对话正在处理工程':running?taskLabel(task.kind)+'中':'正在处理工程操作';

  const root=useRef<HTMLElement>(null),canvas=useRef<HTMLCanvasElement>(null),minimap=useRef<HTMLCanvasElement>(null);
  const graph=useRef<LiteGraphEditor|null>(null),autoPreviewAttempt=useRef('');
  const layout=useStudioLayout(root);
  const [playhead]=useState(createPlayhead);
  const [stage,setStage]=useState<StageMode>('monitor');
  const stageMode=layout==='narrow'&&stage==='split'?'canvas':stage;
  const canvasVisible=stageMode!=='monitor';
  const [pane,setPane]=useState<Pane>('properties'),[assetsOpen,setAssetsOpen]=useState(false);
  const [panel,setPanel]=useState<PanelTab>('audio'),[drawerOpen,setDrawerOpen]=useState(false);
  const [drawerHeight,setDrawerHeight]=useState(320),[flash,setFlash]=useState(0);
  const [zoom,setZoom]=useState(.9),[outputOpen,setOutputOpen]=useState(false),[shortcutsOpen,setShortcutsOpen]=useState(false);
  const [textOpen,setTextOpen]=useState(false),[text,setText]=useState('');
  const [wordOpen,setWordOpen]=useState(false),[instruction,setInstruction]=useState(''),[editScope,setEditScope]=useState<'shot'|'film'>('film');
  const [dismissedTask,setDismissedTask]=useState('');
  const [toasts]=useState(createToastStore);
  const confirm=useConfirmAction(),cancelConfirmation=useCancelConfirmation();

  const selectedShot=project?.shots.find(shot=>shot.id===state.selected);
  const selectedAsset=project?.assets.find(asset=>asset.id===state.selected);
  const graphCheck=useMemo(()=>project?validateGraph(project):null,[project]);
  const spec=useMemo(()=>{try{return project?compileSpec(project):null;}catch{return null;}},[project]);
  const fps=project?project.target.fps.num/project.target.fps.den:30;
  const duration=(project?.shots.reduce((sum,shot)=>sum+shot.durationFrames,0)??0)/fps;
  const assetBaseUrl=snapshot?.assetBaseUrl||snapshot?.previewUrl;
  const assetUrl=(asset:Asset)=>state.localImages[asset.id]||(assetBaseUrl&&asset.path?new URL(asset.path,assetBaseUrl).href:'');

  useEffect(()=>controller.subscribe(toasts.dropUnavailableActions),[controller,toasts]);
  useEffect(()=>()=>{cancelConfirmation?.();toasts.clear();controller.persistDrafts();},[project?.id,cancelConfirmation,toasts,controller]);
  useEffect(()=>setEditScope(selectedShot?'shot':'film'),[selectedShot?.id]);

  function openPanel(tab:PanelTab){
    controller.persistDrafts();
    setPanel(tab);
    setPane('panels');
    setDrawerOpen(true);
    setFlash(value=>value+1);
  }
  function selectItem(id:string|null){
    controller.select(id);
    if(layout==='narrow'&&id&&!(pane==='panels'&&drawerOpen))setPane('properties');
  }
  const selectRef=useRef(selectItem);
  selectRef.current=selectItem;

  const undoAction=(undo:EditUndo|undefined)=>undo?.available()?{label:'撤销',...undo}:undefined;
  const graphUndo=useRef<EditUndo>();
  const onGraphRemoved=(removal:GraphRemoval)=>{
    const messages=removal.shots.length===1?[`已删除镜头「${removal.shots[0]}」`]
      :removal.shots.length?[`已删除 ${removal.shots.length} 个镜头`]:[];
    for(const asset of removal.assets)messages.push(asset.links
      ?`已解除「${asset.name}」的 ${asset.links} 处关联，资产仍保留在资产库`
      :`「${asset.name}」没有关联镜头。可在资产库中删除这个资产。`);
    const action=undoAction(graphUndo.current);
    graphUndo.current=undefined;
    messages.forEach((message,index)=>toasts.toast({message,action:index===messages.length-1?action:undefined}));
  };
  const removedRef=useRef(onGraphRemoved);
  removedRef.current=onGraphRemoved;

  useEffect(()=>{
    if(!project||!canvas.current)return;
    const editor=new LiteGraphEditor(canvas.current,(next,offerUndo)=>{
      if(!offerUndo)return controller.edit(next);
      const result=controller.editWithUndo(next);
      graphUndo.current=result?.undo;
      return result!==null;
    },id=>selectRef.current(id),setZoom,result=>removedRef.current(result),playhead);
    graph.current=editor;
    return()=>{editor.dispose();graph.current=null;};
  },[project?.id,controller,playhead]);
  useEffect(()=>{if(project)graph.current?.setProject(project,assetUrl);},[project,state.localImages,assetBaseUrl]);
  useEffect(()=>graph.current?.setSelected(state.selected),[state.selected,project?.id]);
  useEffect(()=>graph.current?.setInteractive(!locked),[locked,project?.id]);
  useEffect(()=>graph.current?.applyTheme(),[state.scheme]);
  useEffect(()=>{
    graph.current?.attachMinimap(canvasVisible?minimap.current:null);
    if(!canvasVisible)return;
    const frame=requestAnimationFrame(()=>graph.current?.resize());
    return()=>cancelAnimationFrame(frame);
  },[canvasVisible,stageMode,layout,project?.id]);
  useEffect(()=>{
    if(!state.focusSerial)return;
    setStage(current=>current==='canvas'?'monitor':current);
    if(state.selected)graph.current?.focus(state.selected);
  },[state.focusSerial]);

  useEffect(()=>graph.current?.clearShotThumbs(),[project?.id,project?.revision,snapshot?.previewUrl,snapshot?.previewRevision]);
  useEffect(()=>{
    if(!project||!graphCheck?.ok||(snapshot?.previewUrl&&snapshot.previewRevision===project.revision)||
      busy||state.previewing||state.dirty||state.saving||state.conflict||state.sourceDraft)return;
    const key=`${project.id}:${project.revision}`;
    if(autoPreviewAttempt.current===key)return;
    const timer=setTimeout(async()=>{
      if(autoPreviewAttempt.current===key)return;
      const result=await controller.refreshPreview(project.id,project.revision);
      if(result!=='superseded')autoPreviewAttempt.current=key;
    },1200);
    return()=>clearTimeout(timer);
  },[project?.id,project?.revision,graphCheck?.ok,snapshot?.previewUrl,snapshot?.previewRevision,busy,state.previewing,state.dirty,state.saving,state.conflict,state.sourceDraft,controller]);
  useEffect(()=>{
    const editor=graph.current;
    const revision=snapshot?.previewRevision;
    if(!editor||!canvasVisible||!project||!spec?.shots.length||!snapshot?.previewUrl||
      project.revision!==revision||busy||state.dirty||state.saving)return;
    const shots=spec.shots.map(shot=>({id:shot.id,frame:Math.floor((shot.startFrame+shot.endFrame-1)/2)}));
    let active=true;
    async function load(projectId:string,expectedRevision:number){
      for(let start=0;active&&start<shots.length;start+=3){
        const batch=shots.slice(start,start+3);
        try{
          const result=await controller.api.call<{frames:{frame:number;url:string}[]}>('thumbnails',{
            projectId,expectedRevision,frames:batch.map(shot=>shot.frame),
          });
          if(!active)return;
          const urls=new Map(result.frames.map(({frame,url})=>[frame,url]));
          editor?.setShotThumbs(Object.fromEntries(batch.flatMap(({id,frame})=>{
            const url=urls.get(frame);
            return url?[[id,url]]:[];
          })));
        }catch{/* Continue with other batches and keep the card's fallback artwork. */}
      }
    }
    const timer=setTimeout(()=>void load(project.id,revision),180);
    return()=>{active=false;clearTimeout(timer);};
  },[canvasVisible,project?.id,project?.revision,spec,snapshot?.previewUrl,snapshot?.previewRevision,busy,state.dirty,state.saving,controller]);

  useEffect(()=>{if(state.notice)toasts.toast({tone:'success',message:state.notice});},[state.notice,toasts]);
  useEffect(()=>{if(state.error&&!state.conflict&&!state.dirty)toasts.toast({tone:'error',message:state.error});},[state.error,state.conflict,state.dirty,toasts]);

  useEffect(()=>{
    const element=root.current;
    if(!element)return;
    const keyboard=(event:KeyboardEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(event.defaultPrevented||target?.closest('[role=dialog]'))return;
      const editing=target?.closest('input,textarea,select,[contenteditable=true]');
      const modifier=event.ctrlKey||event.metaKey;
      if(modifier&&event.key.toLowerCase()==='k'&&project){
        event.preventDefault();setWordOpen(value=>!value);return;
      }
      if(editing||!project)return;
      if(event.key==='?'){setShortcutsOpen(true);return;}
      if(locked||!modifier)return;
      if(event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?controller.redo():controller.undo();}
      if(event.key.toLowerCase()==='s'){event.preventDefault();void controller.flush();}
    };
    element.addEventListener('keydown',keyboard);
    return()=>element.removeEventListener('keydown',keyboard);
  },[controller,locked,project?.id]);

  async function importFiles(files:FileList){
    if(busy)return;
    for(const file of Array.from(files))await controller.importFile(file);
  }
  function connectOrder(ids:string[]){
    if(!project||locked)return;
    const next=reorderShots(project,ids);
    next.extensions={...next.extensions,graphEdges:ids.map((id,index)=>({from:id,to:ids[index+1]||'film-output'}))};
    controller.edit(next);
  }
  function addShot(){
    if(!project||locked)return;
    const after=selectedShot&&project.shotOrder.includes(selectedShot.id)?selectedShot.id:undefined;
    const next=addPlacedShot(project,after);
    const added=next.shots.find(shot=>!project.shots.some(previous=>previous.id===shot.id));
    if(controller.edit(next)&&added)selectItem(added.id);
  }
  function removeShot(shot:Shot){
    const current=controller.getSnapshot().snapshot?.project;
    if(locked||!current||current.id!==project?.id||!current.shots.some(item=>item.id===shot.id))return;
    const result=controller.editWithUndo(deleteShot(current,shot.id));
    if(result){selectItem(null);toasts.toast({message:`已删除镜头「${shot.title}」`,action:undoAction(result.undo)});}
  }
  async function removeAsset(asset:Asset){
    if(!project||locked)return;
    const confirmed=await confirm({title:`删除资产「${asset.name}」？`,body:'资产将从工程中移除，相关镜头及音视频片段的引用也会移除。',confirmLabel:'删除资产',tone:'danger'});
    const current=controller.getSnapshot().snapshot?.project;
    if(!confirmed||!current||current.id!==project.id||!current.assets.some(item=>item.id===asset.id))return;
    const result=controller.editWithUndo(deleteAsset(current,asset.id));
    if(result){selectItem(null);toasts.toast({message:`已删除资产「${asset.name}」`,action:undoAction(result.undo)});}
  }
  async function generate(kind:'storyboard'|'scenes'){
    if(!project||busy||state.conflict)return;
    if(!modelConfigured){onConfigure();return;}
    if(kind==='storyboard'&&project.shots.length){
      if(!await confirm({title:'重新生成分镜？',body:`当前工程有 ${project.shots.length} 个镜头。生成前的版本可在修改历史中查看。`,confirmLabel:'继续',tone:'danger'}))return;
      const current=controller.getSnapshot().snapshot?.project;
      if(current?.id!==project.id||current.revision!==project.revision)return;
    }
    await controller.generate(kind);
  }
  async function modify(){
    if(busy||state.conflict||!instruction.trim()||(editScope==='shot'&&!selectedShot))return;
    if(!modelConfigured){onConfigure();return;}
    await controller.generate('modify',instruction.trim(),editScope==='shot'?selectedShot?.id:undefined);
    if(!controller.getSnapshot().error){setInstruction('');setWordOpen(false);}
  }

  if(!project||!snapshot)return <main ref={root} className="vs-studio" data-scheme={state.scheme}><div className="vs-loading"><span className="vs-spinner"/>正在打开工作台…</div></main>;

  function step(id:StageId){
    if(id==='storyboard'){setStage('canvas');requestAnimationFrame(()=>graph.current?.fit());}
    else if(id==='scenes')openPanel('source');
    else if(id==='preview')setStage('monitor');
    else openPanel('exports');
  }
  const ordered=[...project.shotOrder.map(id=>project.shots.find(shot=>shot.id===id)).filter((shot):shot is Shot=>!!shot),
    ...project.shots.filter(shot=>!project.shotOrder.includes(shot.id))];
  const hasPreview=!!snapshot.previewUrl&&snapshot.previewRevision!==null;
  const fresh=hasPreview&&snapshot.previewRevision===project.revision&&!state.dirty;
  const completed=task?.status==='complete';
  const latest=project.outputs.at(-1),runningKind=running?task.kind:'';
  const steps:StepInfo[]=[
    {id:'storyboard',label:'分镜',state:runningKind==='storyboard'?'running':graphCheck?.ok?'done':ordered.length?'warning':'current',hint:graphCheck?.ok?`${ordered.length} 个镜头，主链完整`:'查看分镜画布'},
    {id:'scenes',label:'画面',state:runningKind==='scenes'||runningKind==='modify'?'running':hasPreview?'done':graphCheck?.ok?'current':'todo',hint:'查看镜头源码'},
    {id:'preview',label:'预览',state:runningKind==='preview'||state.previewing?'running':fresh?'done':hasPreview?'stale':'todo',hint:fresh?'预览与当前工程一致':'查看影片预览'},
    {id:'export',label:'成片',state:runningKind==='export'?'running':latest?.revision===project.revision?'done':latest?'stale':fresh?'current':'todo',hint:latest?`最近导出 v${latest.revision}`:'查看导出成片'},
  ];
  const menu:MenuItem[]=[
    {id:'output',label:'输出设定',icon:'film',onSelect:()=>setOutputOpen(true)},
    {id:'environment',label:'运行环境',icon:'settings',onSelect:()=>openPanel('environment')},
    {id:'reveal',label:'打开项目文件夹',icon:'folder',disabled:!snapshot.root,onSelect:()=>void controller.action('reveal',{path:snapshot.root})},
    {id:'theme',label:state.scheme==='dark'?'切换到浅色工作台':'切换到深色工作台',icon:'monitor',onSelect:()=>{
      const scheme=state.scheme==='dark'?'light':'dark';
      controller.setScheme(scheme);
      try{localStorage.setItem('yingliu-workbench-scheme',scheme);}catch{/* Use the current theme for this session. */}
    }},
    {id:'keys',label:'快捷键',icon:'keyboard',hint:'?',onSelect:()=>setShortcutsOpen(true)},
    {id:'new',label:'新建影片',icon:'plus',separatorBefore:true,disabled:busy,onSelect:onNew},
    {id:'open',label:'打开工程',icon:'folder',disabled:busy,onSelect:onOpen},
  ];
  const failedTask=task?.status==='failed'&&task.id!==dismissedTask?task:null;
  const bannerError=state.error&&(state.dirty||state.conflict);

  function panelContent():ReactNode{
    switch(panel){
      case 'agent':return <AgentPanel controller={controller} project={project!}/>;
      case 'workflow':return <WorkflowPanel controller={controller} project={project!} selectedShot={selectedShot}/>;
      case 'media':return <MediaPanel controller={controller} project={project!} selectedShot={selectedShot}/>;
      case 'audio':return <AudioPanel project={project!} snapshot={snapshot!} controller={controller} assetUrl={assetUrl} selectedShot={selectedShot} busy={busy}/>;
      case 'source':return <SourceEditor controller={controller} selectedShot={selectedShot} busy={busy} version={`${project!.revision}:${completed?task.id:''}`}/>;
      case 'history':return <HistoryPanel controller={controller}/>;
      case 'tasks':return <TaskPanel controller={controller}/>;
      case 'exports':return <ExportPanel controller={controller} project={project!}/>;
      case 'environment':return <Environment controller={controller} snapshot={snapshot!}/>;
      case 'spec':{
        if(!spec)return <div className="vs-dock-empty"><Icon name="graph"/><p>连接分镜主链后可查看制作要求。</p><small>{graphCheck?.errors.join('；')}</small></div>;
        const markdown=specMarkdown(spec);
        return <div className="vs-spec-view"><div className="vs-spec-meta"><span>{spec.shots.length} 个镜头</span><span>{spec.durationSeconds.toFixed(1)} 秒</span>
          <Button size="sm" icon="copy" onClick={()=>void navigator.clipboard.writeText(markdown).then(()=>controller.notify('制作要求已复制。')).catch(()=>controller.notify('复制失败，可以在下方选择文本。'))}>复制</Button>
          <Button size="sm" icon="download" onClick={()=>downloadText(`${project!.title}-制作要求.md`,markdown,'text/markdown;charset=utf-8')}>导出 Markdown</Button>
          <Button size="sm" icon="download" onClick={()=>downloadText(`${project!.title}-制作要求.json`,JSON.stringify(spec,null,2),'application/json;charset=utf-8')}>导出 JSON</Button>
        </div><pre>{markdown}</pre></div>;
      }
    }
  }
  return <main ref={root} className="vs-studio" data-scheme={state.scheme} data-layout={layout}>
    <StudioHeader project={project} state={state} providers={snapshot.providers} steps={steps} task={task} busy={busy}
      graphOk={!!graphCheck?.ok} canExport={!!graphCheck?.ok&&!state.sourceDraft&&!state.conflict} onHome={onHome}
      onRename={title=>void controller.action('rename',{title},'影片名称已保存。')} onStep={step} onGenerate={kind=>void generate(kind)}
      onExport={()=>{openPanel('tasks');void controller.action('export');}} onCancel={()=>void controller.action('cancel')}
      onHistory={()=>openPanel('history')} onRoute={controller.setRoute} onConfigure={onConfigure} menu={menu}/>
    {(bannerError||state.sourceDraft||failedTask)&&<div className="vs-banners">
      {bannerError&&<div className="vs-banner is-danger" role="alert"><Icon name="warning"/><span>{state.error}</span>
        {state.dirty&&<Button size="sm" icon="download" onClick={()=>downloadText(`${project.title}-本地修改.json`,JSON.stringify(project,null,2),'application/json;charset=utf-8')}>保存本地副本</Button>}
        {state.conflict?<Button size="sm" icon="refresh" onClick={()=>void controller.load(true)}>重新载入保存版本</Button>:<Button size="sm" icon="check" onClick={()=>void controller.flush()}>重试保存</Button>}
      </div>}
      {state.sourceDraft&&<div className="vs-banner is-info" role="status"><Icon name="code"/><span>{state.sourceDraftCount||1} 份源码草稿已保留</span>
        <Button size="sm" onClick={()=>{const draft=controller.sourceDrafts().find(value=>project.shots.some(shot=>shot.id===value.shotId));controller.select(draft?.shotId??null);openPanel('source');}}>查看源码草稿</Button>
      </div>}
      {failedTask&&<div className="vs-banner is-warning" role="status"><Icon name="warning"/><span>{failedTask.message||taskLabel(failedTask.kind)}{failedTask.error&&<small className="vs-task-error">{failedTask.error}</small>}</span>
        <Button size="sm" icon="tasks" onClick={()=>openPanel('tasks')}>查看任务记录</Button><IconButton icon="close" label="关闭任务提示" onClick={()=>setDismissedTask(failedTask.id)}/>
      </div>}
    </div>}
    <div className={`vs-workbench ${assetsOpen?'is-assets-open':''}`} data-pane={pane} data-drawer={drawerOpen?'open':'closed'}>
      <AssetsPanel project={project} selectedId={state.selected} assetUrl={assetUrl} pending={state.pending} locked={locked||busy}
        onSelect={id=>{selectItem(id);setPane('properties');setAssetsOpen(false);}} onImport={files=>void importFiles(files)} onAddText={()=>setTextOpen(true)}
        onDelete={asset=>void removeAsset(asset)} onClose={layout==='medium'?()=>setAssetsOpen(false):undefined}/>
      {assetsOpen&&layout==='medium'&&<button type="button" className="vs-scrim" aria-label="收起资产库" onClick={()=>setAssetsOpen(false)}/>}
      <Stage project={project} snapshot={snapshot} state={state} controller={controller} playhead={playhead} layout={layout}
        stageMode={stageMode} onStageMode={setStage} assetsOpen={layout==='narrow'?pane==='assets':assetsOpen}
        onToggleAssets={()=>layout==='narrow'?setPane(current=>current==='assets'?'properties':'assets'):setAssetsOpen(open=>!open)}
        onOutputSettings={()=>setOutputOpen(true)} duration={duration} selectedShot={selectedShot} locked={locked} busy={busy}
        graphCheck={graphCheck} canvasRef={canvas} minimapRef={minimap} graphRef={graph} zoom={zoom}
        onAddShot={addShot} onRefreshPreview={()=>void controller.action('preview')} onConnectOrder={connectOrder} ordered={ordered}
        wordOpen={wordOpen} onWordOpen={setWordOpen} editScope={editScope} onEditScope={setEditScope} instruction={instruction}
        onInstruction={setInstruction} onModify={()=>void modify()} modelConfigured={modelConfigured}/>
      <Timeline shots={ordered} fps={fps} selectedId={selectedShot?.id??null} locked={locked} playhead={playhead}
        onSelect={id=>{selectItem(id);if(canvasVisible)graph.current?.focus(id);}} onReorder={connectOrder} onAdd={addShot}
        onDelete={id=>{const shot=project.shots.find(value=>value.id===id);if(shot)removeShot(shot);}}/>
      <div className="vs-pane-switch vs-segmented" role="tablist" aria-label="切换面板">
        {([['properties','info','属性'],['assets','image','资产库'],['panels','drawer','工作面板']] as const).map(([id,icon,label])=><button
          type="button" role="tab" key={id} aria-selected={pane===id} className={pane===id?'is-active':''} onClick={()=>setPane(id)}><Icon name={icon}/><span>{label}</span></button>)}
      </div>
      <PropertiesPanel project={project} controller={controller} selectedShot={selectedShot} selectedAsset={selectedAsset}
        assetUrl={assetUrl} fps={fps} duration={duration} locked={locked} lockReason={lockReason} commit={controller.edit}
        onOpenPanel={openPanel} onDeleteShot={removeShot} onDeleteAsset={asset=>void removeAsset(asset)}
        onDuplicateShot={shot=>controller.edit(duplicateShot(project,shot.id))}/>
      <BottomDrawer tabs={[...drawerTabs]} active={panel} open={drawerOpen} height={drawerHeight} flash={flash}
        onSelect={tab=>{controller.persistDrafts();setPanel(tab);setDrawerOpen(true);}}
        onToggle={()=>{controller.persistDrafts();setDrawerOpen(open=>!open);}} onResize={setDrawerHeight}>
        {panelContent()}
      </BottomDrawer>
    </div>
    {task?.status==='complete'&&<div className="vs-task is-complete" role="status"><Icon name="check"/><span>{task.message||taskLabel(task.kind)+'已完成'}</span></div>}
    {outputOpen&&<Dialog label="输出设定" onClose={()=>setOutputOpen(false)} className="vs-output-modal">
      <div className="vs-section-header"><h2>输出设定</h2><IconButton icon="close" label="关闭输出设定" onClick={()=>setOutputOpen(false)}/></div>
      <fieldset className="vs-dialog-fields" disabled={locked}><OutputSettings project={project} onChange={controller.edit}/></fieldset>
    </Dialog>}
    {textOpen&&<Dialog label="添加文字资产" onClose={()=>setTextOpen(false)} busy={state.pending}>
      <div className="vs-section-header"><h2>添加文字资产</h2><IconButton icon="close" label="关闭" disabled={state.pending} onClick={()=>setTextOpen(false)}/></div>
      <textarea className="vs-textasset-input" data-dialog-autofocus aria-label="文字资产内容" rows={8} value={text} onChange={event=>setText(event.target.value)} placeholder="粘贴文案、故事、产品介绍或风格参考…"/>
      <div className="vs-modal-actions"><Button variant="primary" icon="plus" disabled={!text.trim()||busy} onClick={()=>void controller.action('import',{
        name:truncate(text.trim().split('\n')[0]||'文字素材',22),mime:'text/plain',text,
      }).then(saved=>{if(saved){setTextOpen(false);setText('');}})}>加入资产库</Button></div>
    </Dialog>}
    {shortcutsOpen&&<Dialog label="快捷键" onClose={()=>setShortcutsOpen(false)}><div className="vs-section-header"><h2>快捷键</h2><IconButton icon="close" label="关闭快捷键" onClick={()=>setShortcutsOpen(false)}/></div>
      <dl className="vs-shortcut-list"><dt><kbd>空格</kbd></dt><dd>播放或暂停预览</dd><dt><kbd>Alt ← / →</kbd></dt><dd>逐帧查看，或移动已聚焦的时间线镜头</dd><dt><kbd>Ctrl / ⌘ K</kbd></dt><dd>用文字修改</dd><dt><kbd>Ctrl / ⌘ Z</kbd></dt><dd>撤销，按住 Shift 重做</dd><dt><kbd>Ctrl / ⌘ S</kbd></dt><dd>保存工程</dd></dl>
    </Dialog>}
    <Toasts store={toasts}/><ConfirmHost/>
  </main>;
}

export function FilmMark(){return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.6"/><path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5" stroke="currentColor" strokeWidth="1.4"/><path d="m11 9 4 3-4 3V9Z" fill="currentColor"/></svg>;}

function Environment({controller,snapshot}:{controller:StudioController;snapshot:StudioSnapshot}){
  const [settings,setSettings]=useState({...snapshot.environment}),environmentKey=JSON.stringify(snapshot.environment);useEffect(()=>setSettings({...snapshot.environment}),[environmentKey]);
  const [health,setHealth]=useState<{canRender:boolean;tools:Record<string,{available:boolean;version?:string;message?:string}>}|null>(null),[checking,setChecking]=useState(false),[error,setError]=useState('');
  const checks=[['browserPath','Chromium 浏览器','browserAvailable'],['ffmpegPath','FFmpeg 编码器','ffmpegAvailable'],['ffprobePath','ffprobe 媒体检查','ffprobeAvailable']] as const;
  async function choose(key:'browserPath'|'ffmpegPath'|'ffprobePath'){try{const path=await window.yingliu?.pickExecutable?.();if(path){setSettings(previous=>({...previous,[key]:path}));setHealth(null);}}catch(cause){setError(cause instanceof Error?cause.message:'文件选择失败');}}
  async function save(){setChecking(true);setError('');try{await controller.action('environment',{browserPath:settings.browserPath,ffmpegPath:settings.ffmpegPath,ffprobePath:settings.ffprobePath,maxVideoBytes:settings.maxVideoBytes??512*1024*1024});if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);const checked=await controller.api.call<NonNullable<typeof health>>('app.health');setHealth(checked);if(!checked.canRender)setError('部分工具无法执行。工程可以继续编辑；请修正路径后重新检查。');else controller.notify('本地浏览器、编码器和媒体检查工具已就绪。');}catch(cause){setError(cause instanceof Error?cause.message:'环境检查失败');}finally{setChecking(false);}}
  return <div className="vs-environment"><div className="vs-environment-intro"><h3>本地渲染环境</h3><p>预览在浏览器中运行；成片由本地 Chromium 逐帧捕获，再交给 FFmpeg 编码。路径留空时使用已检测到的环境。</p></div><div className="vs-environment-fields">{checks.map(([key,label,available],index)=>{const tool=health?.tools[['browser','ffmpeg','ffprobe'][index]!],ready=tool?.available??snapshot.environment[available];return <Field key={key} label={label}><div className="vs-env-row"><span className={ready?'is-ready':'is-missing'}>{ready?(health?'可执行':'已检测到'):'待配置'}</span><input aria-label={label+'路径'} value={settings[key]} placeholder="工具的绝对路径" onChange={e=>{setSettings({...settings,[key]:e.target.value});setHealth(null);}}/>{window.yingliu?.pickExecutable&&<Button disabled={checking} onClick={()=>void choose(key)}>选择文件</Button>}</div>{tool&&<small className="vs-env-result">{tool.version||tool.message}</small>}</Field>;})}<Field label="视频文件上限（MiB）"><input aria-label="视频文件上限（MiB）" type="number" min="1" max="512" step="1" value={(settings.maxVideoBytes??512*1024*1024)/(1024*1024)} onChange={event=>setSettings({...settings,maxVideoBytes:Number(event.target.value)*1024*1024})}/><small>每个导入或生成视频的最大大小，默认 512 MiB。可降低上限以控制本地存储和处理开销。</small></Field><Button className="vs-primary" icon="check" disabled={checking||controller.busy||!(settings.maxVideoBytes===undefined||Number.isInteger(settings.maxVideoBytes/(1024*1024))&&settings.maxVideoBytes>=1024*1024&&settings.maxVideoBytes<=512*1024*1024)} onClick={()=>void save()}>{checking?'正在执行检查':'保存并检查环境'}</Button>{error&&<p className="vs-inline-error" role="alert">{error}</p>}{health?.canRender&&<p className="vs-env-result" role="status">本地浏览器、编码器和媒体检查工具已就绪。</p>}</div></div>;
}
function truncate(value:string,length:number):string{const units=[...value];return units.length>length?units.slice(0,length-1).join('')+'…':value;}

function downloadText(name:string,text:string,mime:string):void{const blob=new Blob([text],{type:mime});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name.replace(/[\\/:*?"<>|]/g,'-');document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
