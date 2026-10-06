import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { ChatInput, ChatMessage, Conversation, ProviderSettings } from '../app/contracts.ts';
import type { StudioApi, StudioSnapshot } from '../shared/types.ts';
import { FilmMark, Studio } from './Studio.tsx';
import { StudioController } from './controller.ts';

type ChatReply={conversation:Conversation;snapshot:StudioSnapshot};
const suggestions=[
  {title:'做一支介绍短片',text:'制作一支 15 秒的映流介绍短片，讲清楚对话构建、节点编辑和本地导出。使用深蓝背景和薄荷绿强调。'},
  {title:'把想法变成分镜',text:'帮我构建一支 15 秒的「把想法变成影片」短片，分为开场、过程和收尾三个镜头。'},
  {title:'打磨选中的镜头',text:'把当前镜头改为柔和的淡入，延长到 6 秒，使用奶油色背景。'},
];
function errorMessage(value:unknown):string{return value instanceof Error?value.message:String(value);}
function timeLabel(value:string):string{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});}
function AppIcon({name}:{name:'chat'|'settings'|'send'|'folder'|'plus'|'close'|'chevron'|'check'}){
  const paths={chat:<><path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/></>,settings:<><path d="M5 3v18M12 3v18M19 3v18M2 8h6M9 15h6M16 9h6"/></>,send:<><path d="m3 3 18 9-18 9 4-9-4-9ZM7 12h14"/></>,folder:<path d="M3 6h7l2 3h9v11H3V6Z"/>,plus:<path d="M12 5v14M5 12h14"/>,close:<path d="m5 5 14 14M19 5 5 19"/>,chevron:<path d="m15 5-7 7 7 7"/>,check:<path d="m5 12 4 4L19 6"/>};
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function App({controller,api}:{controller:StudioController;api:StudioApi}){
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const project=state.snapshot?.project;
  const selectedShot=project?.shots.find(shot=>shot.id===state.selected);
  const [collapsed,setCollapsed]=useState(()=>window.innerWidth<1220);
  const [conversation,setConversation]=useState<Conversation|null>(null);
  const [historyLoading,setHistoryLoading]=useState(true);
  const [draft,setDraft]=useState('');
  const [sending,setSending]=useState(false),[canceling,setCanceling]=useState(false);
  const [pendingMessage,setPendingMessage]=useState<{content:string;createdAt:string}|null>(null);
  const [chatError,setChatError]=useState(''),[notice,setNotice]=useState('');
  const [settings,setSettings]=useState<ProviderSettings|null>(null),[settingsOpen,setSettingsOpen]=useState(false);
  const [importOpen,setImportOpen]=useState(false),[importPath,setImportPath]=useState(''),[projectBusy,setProjectBusy]=useState(false);
  const messagesEnd=useRef<HTMLDivElement>(null),inputRef=useRef<HTMLTextAreaElement>(null);
  const historySerial=useRef(0),sendingRef=useRef(false);
  const routeInitialized=useRef(false);
  const demo=state.route.provider!=='custom';
  const taskRunning=state.snapshot?.task?.status==='running';
  const blocked=sending||projectBusy||state.pending||!!taskRunning;

  useEffect(()=>{let active=true;api.call<ProviderSettings>('providers.get').then(value=>{if(active)setSettings(value);}).catch(cause=>{if(active)setChatError(errorMessage(cause));});return()=>{active=false;};},[api]);
  useEffect(()=>{if(!settings||state.loading||routeInitialized.current)return;routeInitialized.current=true;controller.setRoute({provider:settings.mode==='demo'?'demo':'custom',model:settings.mode==='demo'?'offline-director':settings.config.model});},[settings,state.loading,controller]);
  useEffect(()=>{
    if(state.loading||sendingRef.current)return;
    const serial=++historySerial.current;setHistoryLoading(true);
    api.call<Conversation>('chat.history',{projectId:project?.id}).then(value=>{if(serial===historySerial.current)setConversation(value);}).catch(cause=>{if(serial===historySerial.current)setChatError(errorMessage(cause));}).finally(()=>{if(serial===historySerial.current)setHistoryLoading(false);});
    return()=>{historySerial.current++;};
  },[api,project?.id,state.loading]);
  useEffect(()=>{if(conversation?.messages.length||pendingMessage||sending)messagesEnd.current?.scrollIntoView({block:'nearest',behavior:'smooth'});},[conversation?.messages.length,pendingMessage,sending]);

  async function send(event?:FormEvent){
    event?.preventDefault();const content=draft.trim();if(!content||blocked)return;
    sendingRef.current=true;historySerial.current++;setSending(true);setCanceling(false);setChatError('');setNotice('');setPendingMessage({content,createdAt:new Date().toISOString()});
    try{
      await controller.flush();const current=controller.getSnapshot();if(controller.hasUnsavedChanges)throw new Error(current.error||'工程修改尚未保存，请重试后继续创作。');
      const shotId=current.snapshot?.project?.shots.some(shot=>shot.id===current.selected)?current.selected??undefined:undefined;
      const input:ChatInput={message:content,projectId:current.snapshot?.project?.id,shotId,provider:current.route.provider||'demo',model:current.route.model||'offline-director'};
      const reply=await api.call<ChatReply>('chat.send',input);
      setConversation(reply.conversation);setDraft('');setPendingMessage(null);
      await controller.load();
      const assistant=[...reply.conversation.messages].reverse().find(message=>message.role==='assistant');
      const focus=assistant?.actions?.find(action=>action.shotId||action.frame!==undefined);
      if(reply.snapshot.project)await controller.focusProject(reply.snapshot.project.id,{shotId:focus?.shotId??shotId,frame:focus?.frame});
      setNotice('对话与工程已保存');
    }catch(cause){
      setChatError(errorMessage(cause));setPendingMessage(null);
      try{const current=controller.getSnapshot();setConversation(await api.call<Conversation>('chat.history',{projectId:current.snapshot?.project?.id}));await controller.load();}catch{/* Keep the actionable original error visible. */}
    }finally{sendingRef.current=false;setSending(false);setCanceling(false);setHistoryLoading(false);}
  }
  async function cancel(){
    if(!sending||canceling)return;setCanceling(true);setChatError('');
    try{await api.call('chat.cancel',{projectId:project?.id});setNotice('已请求取消，正在保留当前工程');}catch(cause){setChatError(errorMessage(cause));setCanceling(false);}
  }
  async function openProject(path:string){
    if(!path.trim()||blocked)return;setProjectBusy(true);setChatError('');
    try{await controller.action('open',{path:path.trim()});const error=controller.getSnapshot().error;if(error)throw new Error(error);setImportOpen(false);setImportPath('');setNotice('工程已打开，对话记录已回读');}catch(cause){setChatError(errorMessage(cause));}finally{setProjectBusy(false);}
  }
  async function chooseProject(){
    if(!window.yingliu?.pickProject){setImportOpen(true);return;}
    try{const path=await window.yingliu.pickProject();if(path)await openProject(path);}catch(cause){setChatError(errorMessage(cause));}
  }
  async function createBlank(){
    if(blocked)return;setProjectBusy(true);setChatError('');setNotice('');
    try{await controller.action('create',{title:'未命名影片',topic:'',blank:true});const error=controller.getSnapshot().error;if(error)throw new Error(error);setNotice('空白工程已建立，可以手动添加镜头或开始对话');}catch(cause){setChatError(errorMessage(cause));}finally{setProjectBusy(false);}
  }
  async function jump(action:NonNullable<ChatMessage['actions']>[number]){
    if(blocked)return;setChatError('');
    try{const id=action.projectId??project?.id;if(!id)throw new Error('这条记录还没有关联工程');await controller.focusProject(id,{shotId:action.shotId,frame:action.frame});}catch(cause){setChatError(errorMessage(cause));}
  }
  async function providerSaved(value:ProviderSettings){
    setSettings(value);await controller.load();controller.setRoute({provider:value.mode==='demo'?'demo':'custom',model:value.mode==='demo'?'offline-director':value.config.model});
  }
  return <div className={`yl-app ${collapsed?'is-chat-collapsed':''}`}>
    <header className="yl-header">
      <a className="yl-logo" href="#" onClick={event=>event.preventDefault()} aria-label="映流 Studio"><span><FilmMark/></span><strong>映流<span>Studio</span></strong><small>独立应用 Demo</small></a>
      <div className="yl-header-center"><span className="yl-status-dot"/>本地工程<span className="yl-header-divider"/>{demo?'离线创作演示':settings?.config.name||'自定义模型'}</div>
      <div className="yl-header-actions"><span className={`yl-mode-badge ${demo?'is-demo':''}`} data-testid="provider-mode">{demo?'离线演示 · 未调用模型':'自定义接口'}</span><button className="yl-button yl-icon-button" title={collapsed?'展开对话':'收起对话'} aria-label={collapsed?'展开对话':'收起对话'} onClick={()=>setCollapsed(!collapsed)}><AppIcon name="chat"/></button><button className="yl-button" onClick={()=>setSettingsOpen(true)}><AppIcon name="settings"/><span>模型设置</span></button></div>
    </header>
    <div className="yl-body">
      {!collapsed&&<aside className="yl-chat" aria-label="创作对话">
        <div className="yl-chat-heading"><div><span className="yl-eyebrow">DIRECT WITH WORDS</span><h1>和想法聊一聊</h1></div><button className="yl-button yl-icon-button yl-subtle" aria-label="收起对话栏" onClick={()=>setCollapsed(true)}><AppIcon name="chevron"/></button></div>
        <div className="yl-chat-tools"><button className="yl-button" disabled={blocked} onClick={()=>void createBlank()}><AppIcon name="plus"/>空白工程</button><button className="yl-button" disabled={blocked} onClick={()=>void chooseProject()}><AppIcon name="folder"/>打开工程</button></div>
        <div className={`yl-provider-note ${demo?'is-demo':''}`}><span className="yl-status-dot"/><div><strong>{demo?'离线演示导演':settings?.config.name||'自定义接口'}</strong><p>{demo?'演示用固定规则构建与修改影片，未调用真实模型。':'使用你在本应用配置的模型接口。'}</p></div>{demo&&<button onClick={()=>setSettingsOpen(true)}>配置模型 ↗</button>}</div>
        <div className="yl-messages" aria-live="polite" aria-busy={historyLoading||sending}>
          {historyLoading&&!conversation?<div className="yl-history-loading"><span className="yl-spinner"/>读取本地对话…</div>:!conversation?.messages.length&&!pendingMessage?<div className="yl-chat-welcome"><span className="yl-welcome-symbol"><AppIcon name="chat"/></span><h2>从一句话开始</h2><p>描述主题、画幅和风格。初稿会出现在右侧分镜画布，你可以继续对话，也可以自己连接镜头。</p><div className="yl-suggestions">{suggestions.map(item=><button key={item.title} onClick={()=>{setDraft(item.text);inputRef.current?.focus();}}><span>{item.title}</span><small>{item.text}</small><span className="yl-suggestion-arrow">↗</span></button>)}</div><p className="yl-small-note">演示支持镜头文字、背景、运动与时长等局部修改。</p></div>:conversation?.messages.map(message=><article key={message.id} className={`yl-message is-${message.role}`} data-message-id={message.id}><div className="yl-message-meta"><span className="yl-avatar">{message.role==='user'?'你':'映'}</span><strong>{message.role==='user'?'你':conversation.provider==='demo'?'映流 · 离线演示':'映流 · 创作助手'}</strong><time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time></div><div className="yl-message-content">{message.content}</div>{message.actions?.length? <div className="yl-message-actions">{message.actions.map((action,index)=><button key={`${action.label}-${index}`} disabled={blocked} onClick={()=>void jump(action)}>{action.label}<span>↗</span></button>)}</div>:null}</article>)}
          {pendingMessage&&<article className="yl-message is-user"><div className="yl-message-meta"><span className="yl-avatar">你</span><strong>你</strong><time>{timeLabel(pendingMessage.createdAt)}</time></div><div className="yl-message-content">{pendingMessage.content}</div></article>}
          {sending&&<div className="yl-chat-running" role="status"><span className="yl-spinner"/><div><strong>{canceling?'正在取消创作任务':'正在整理分镜与画面'}</strong><small>等待当前任务完成后，工程会同步到右侧。</small></div><button className="yl-button" disabled={canceling} onClick={()=>void cancel()}>{canceling?'取消中':'取消'}</button></div>}
          <div ref={messagesEnd}/>
        </div>
        {chatError&&<div className="yl-error" role="alert"><span>{chatError}</span><button aria-label="关闭对话错误" onClick={()=>setChatError('')}>×</button></div>}
        {notice&&!chatError&&<div className="yl-chat-notice" role="status"><AppIcon name="check"/>{notice}</div>}
        <form className="yl-composer" onSubmit={event=>void send(event)}>
          <div className="yl-context"><span className={selectedShot?'is-shot':''}>{selectedShot?`当前镜头 · ${selectedShot.title}`:project?`整部影片 · ${project.title}`:'新影片'}</span>{selectedShot&&<button type="button" onClick={()=>controller.select(null)} disabled={blocked}>改整片</button>}</div>
          <textarea ref={inputRef} aria-label="创作指令" rows={4} placeholder={selectedShot?'告诉我如何改变这个镜头…':'想做一支什么样的视频？'} value={draft} disabled={sending} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void send();}}}/>
          <div className="yl-composer-bottom"><small>Ctrl / ⌘ Enter 发送</small><button className="yl-button yl-primary" type="submit" disabled={!draft.trim()||blocked}><span>{sending?'创作中':'开始创作'}</span><AppIcon name="send"/></button></div>
        </form>
        <div className="yl-chat-foot">对话、分镜与手动编辑，共用同一份本地工程。</div>
      </aside>}
      {collapsed&&<button className="yl-chat-rail" onClick={()=>setCollapsed(false)} aria-label="展开创作对话"><AppIcon name="chat"/><span>创作对话</span><span>↗</span></button>}
      <div className="yl-editor-shell">
        <div className="yl-editor-heading"><div><span className="yl-eyebrow">STORYBOARD WORKSPACE</span><span>让每一个镜头，都可以亲手打磨。</span></div><span>{project?`${project.shots.length} 个镜头 · v${project.revision}`:'等待你的第一个想法'}</span></div>
        <fieldset className={`yl-editor ${sending?'is-conversing':''}`} disabled={sending} aria-busy={sending}><Studio controller={controller}/></fieldset>
        {collapsed&&chatError&&<div className="yl-error" role="alert">{chatError}</div>}
      </div>
    </div>
    {settingsOpen&&<ProviderDialog api={api} initial={settings} onClose={()=>setSettingsOpen(false)} onSave={providerSaved} blocked={blocked}/>}
    {importOpen&&<div className="yl-modal-backdrop" onMouseDown={event=>{if(event.currentTarget===event.target)setImportOpen(false);}}><section className="yl-modal" role="dialog" aria-modal="true" aria-labelledby="yl-import-title"><div className="yl-modal-heading"><div><span className="yl-eyebrow">LOCAL PROJECT</span><h2 id="yl-import-title">打开现有工程</h2></div><button className="yl-button yl-icon-button" aria-label="关闭导入" onClick={()=>setImportOpen(false)}><AppIcon name="close"/></button></div><p>选择含 project.json 的影片工程目录。打开后保留已有分镜、素材和本地对话记录。</p><label className="yl-field"><span>工程目录的绝对路径</span><input autoFocus value={importPath} onChange={event=>setImportPath(event.target.value)} placeholder="/Users/…/我的影片" onKeyDown={event=>{if(event.key==='Enter')void openProject(importPath);}}/></label>{chatError&&<p className="yl-error" role="alert">{chatError}</p>}<div className="yl-modal-actions"><button className="yl-button" onClick={()=>setImportOpen(false)}>取消</button><button className="yl-button yl-primary" disabled={!importPath.trim()||blocked} onClick={()=>void openProject(importPath)}>{projectBusy?'正在打开':'打开工程'}</button></div></section></div>}
  </div>;
}

function ProviderDialog({api,initial,onClose,onSave,blocked}:{api:StudioApi;initial:ProviderSettings|null;onClose:()=>void;onSave:(settings:ProviderSettings)=>Promise<void>;blocked:boolean}){
  const [mode,setMode]=useState<'demo'|'custom'>(initial?.mode??'demo');
  const [name,setName]=useState(initial?.config.name||'DeepSeek');
  const [baseUrl,setBaseUrl]=useState(initial?.config.baseUrl||'https://api.deepseek.com/v1');
  const [model,setModel]=useState(initial?.config.model||'deepseek-chat');
  const [vision,setVision]=useState(initial?.config.supportsVision??false);
  const [apiKey,setApiKey]=useState(''),[hasKey,setHasKey]=useState(initial?.hasKey??false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)onClose();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[onClose,busy]);
  async function save(check=false){
    if(busy||blocked)return;setBusy(true);setError('');setStatus('');
    try{
      const value=await api.call<ProviderSettings>('providers.save',{id:'custom',name:name.trim(),baseUrl:baseUrl.trim(),model:model.trim(),supportsVision:vision,mode,...(apiKey.trim()?{apiKey:apiKey.trim()}:{})});
      setApiKey('');setHasKey(value.hasKey);await onSave(value);
      if(check){const checked=await api.call<{ok:boolean;message:string}>('providers.check',{provider:mode==='demo'?'demo':'custom'});if(!checked.ok)throw new Error(checked.message);setStatus(checked.message);}
      else setStatus(mode==='demo'?'已切换为离线演示；未调用真实模型。':'模型设置已保存，密钥不会回显。');
    }catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}
  }
  return <div className="yl-modal-backdrop" onMouseDown={event=>{if(event.currentTarget===event.target&&!busy)onClose();}}><section className="yl-modal yl-provider-modal" role="dialog" aria-modal="true" aria-labelledby="yl-provider-title">
    <div className="yl-modal-heading"><div><span className="yl-eyebrow">MODEL CONNECTION</span><h2 id="yl-provider-title">配置你的创作模型</h2></div><button className="yl-button yl-icon-button" aria-label="关闭模型设置" disabled={busy} onClick={onClose}><AppIcon name="close"/></button></div>
    <p>先用离线演示体验完整流程；连接模型后，对话和镜头生成使用同一接口。</p>
    <div className="yl-provider-tabs"><button className={mode==='demo'?'is-active':''} disabled={busy} onClick={()=>setMode('demo')}><strong>离线演示</strong><small>固定规则 · 无网络调用</small></button><button className={mode==='custom'?'is-active':''} disabled={busy} onClick={()=>setMode('custom')}><strong>DeepSeek / 自定义</strong><small>OpenAI 兼容接口</small></button></div>
    {mode==='demo'?<div className="yl-demo-detail"><span className="yl-mode-badge is-demo">DEMO</span><h3>让创作流程先运行起来</h3><p>离线演示会构建三个镜头，并支持修改标题、背景、运动和时长。所有结果明确标记为演示；它不代表真实模型生成质量。</p></div>:<div className="yl-provider-fields"><div className="yl-field-pair"><label className="yl-field"><span>接口名称</span><input value={name} onChange={event=>setName(event.target.value)} placeholder="DeepSeek" disabled={busy}/></label><label className="yl-field"><span>模型 ID</span><input value={model} onChange={event=>setModel(event.target.value)} placeholder="deepseek-chat" disabled={busy}/></label></div><label className="yl-field"><span>API Base URL</span><input value={baseUrl} onChange={event=>setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com/v1" disabled={busy} inputMode="url"/></label><label className="yl-field"><span>API Key <small>{hasKey?'已有密钥；留空保留':'尚未配置'}</small></span><input type="password" autoComplete="new-password" value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder={hasKey?'输入新密钥可替换，保存后不回显':'在本应用中配置你的密钥'} disabled={busy}/></label><label className="yl-check-field"><input type="checkbox" checked={vision} onChange={event=>setVision(event.target.checked)} disabled={busy}/><span>记录模型具备图片能力（本演示仅发送文字）</span></label><p className="yl-credential-note">本演示尚未把图片像素发送给模型。密钥由应用凭据服务保存，不写入影片工程或对话；保存后输入框清空，仅显示配置状态。</p></div>}
    {error&&<p className="yl-error" role="alert">{error}</p>}{status&&<p className="yl-dialog-success" role="status"><AppIcon name="check"/>{status}</p>}
    <div className="yl-modal-actions"><button className="yl-button" disabled={busy||blocked} onClick={()=>void save(true)}>{busy?'正在处理':'保存并检查连接'}</button><button className="yl-button yl-primary" disabled={busy||blocked||(mode==='custom'&&(!model.trim()||!baseUrl.trim()))} onClick={()=>void save(false)}>{busy?'正在保存':'保存设置'}</button></div><small className="yl-dialog-footnote">检查连接只检测接口可用性；发送创作指令后才会开始模型生成。</small>
  </section></div>;
}
