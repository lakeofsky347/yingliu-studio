/** Local protocol + real media acceptance. No paid model or TTS provider is contacted. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {createApplication,MemorySecrets,type Application} from '../src/app/application.ts';
import {defaultSceneSource} from '../src/core/index.ts';
import {detectEnvironment,VideoRenderer} from '../src/host/renderer.ts';
import type {ProviderConnection,ModelDefinition,ModelProtocol,ModelRole,Modality} from '../src/models/contracts.ts';
import type {WorkflowRecord} from '../src/workflows/contracts.ts';
import type {MediaTask} from '../src/jobs/contracts.ts';
import type {StudioSnapshot,SceneSource} from '../src/shared/types.ts';

const execute=promisify(execFile),environment=detectEnvironment();
const output=resolve('artifacts/acceptance-v03/multimodal-film-'+Date.now()),temporary=await mkdtemp(join(tmpdir(),'yingliu-film-acceptance-'));
await mkdir(output,{recursive:true});
const checks:{name:string;status:'PASS';details?:unknown}[]=[],requests:{method:string;path:string;model?:string;authenticated:boolean;imageCount?:number;imageBytes?:number}[]=[];
const workflows:WorkflowRecord[]=[];let app:Application|undefined,baseUrl='';
let report:Record<string,unknown>={application:'映流 Studio',version:'0.3.0',checkedAt:new Date().toISOString(),status:'RUNNING',checks,providerEvidence:'仅本机 HTTP 模拟供应商；不代表真实模型画质或语音质量',renderEvidence:'真实 Chromium 捕帧与 FFmpeg 编解码',platform:process.platform,architecture:process.arch};
function passed(name:string,details?:unknown){checks.push({name,status:'PASS',...(details===undefined?{}:{details})});console.log('PASS '+name);}
async function waitFor<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean,label:string,timeoutMs=120_000):Promise<T>{const end=Date.now()+timeoutMs;while(true){const result=await read();if(predicate(result))return result;if(Date.now()>end)throw new Error(label+'超时');await new Promise(accept=>setTimeout(accept,40));}}
const fixtureFiles={image:join(temporary,'image.png'),video:join(temporary,'video.mp4'),speech:join(temporary,'speech.wav')};
const jobs=new Map<string,{jobId:string;status:'running'|'succeeded'}>();
// Observe encoder output before the normal QA gate; never suppress or replace production validation.
const rendererPrototype=VideoRenderer.prototype as unknown as {mediaQa:(file:string,...args:any[])=>Promise<Record<string,unknown>>};
const normalMediaQa=rendererPrototype.mediaQa;
rendererPrototype.mediaQa=async function(file:string,...args:any[]){
  const observed=JSON.parse((await execute(environment.ffprobePath,['-v','error','-show_entries','stream=codec_type,codec_name,duration,start_time,sample_rate,channels,width,height,r_frame_rate,nb_frames:format=duration','-of','json',file])).stdout);
  report.observedEncoderMedia=observed;await copyFile(file,join(output,'encoder-before-qa.mp4'));
  const exportDirectory=dirname(file),audioDirectory=join(exportDirectory,'snapshot/runtime/audio');
  for(const name of ['ffmpeg.log','audio-plan.json'])await copyFile(join(exportDirectory,name),join(output,name));
  for(const name of await readdir(audioDirectory))if(name.startsWith('mix-')&&name.endsWith('.wav')){
    await copyFile(join(audioDirectory,name),join(output,'encoder-input.wav'));
    report.observedAudioInput=JSON.parse((await execute(environment.ffprobePath,['-v','error','-show_entries','stream=codec_type,codec_name,duration,start_time,sample_rate,channels:format=duration','-of','json',join(audioDirectory,name)])).stdout);
  }
  return normalMediaQa.call(this,file,...args);
};
const gateway=createServer(async(req,res)=>{
  try{
    const address=new URL(req.url??'/',baseUrl),chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
    const receipt:{method:string;path:string;model?:string;authenticated:boolean;imageCount?:number;imageBytes?:number}={method:req.method??'GET',path:address.pathname,...(typeof body.model==='string'?{model:body.model}:{}),authenticated:!!req.headers.authorization};requests.push(receipt);
    const json=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(address.pathname==='/v1/models'){json({data:[{id:'local-director'},{id:'local-scene'},{id:'local-vision'}]});return;}
    if(address.pathname==='/v1/chat/completions'){
      const content=body.messages.at(-1).content,parts=typeof content==='string'?[]:content,context=JSON.parse(typeof content==='string'?content:parts.find((part:any)=>part.type==='text').text);
      let result:unknown;
      if(body.model==='local-director')result={shots:context.shots.map((shot:{id:string;title:string})=>({shotId:shot.id,prompt:'为 '+shot.title+' 制作清楚画面',narration:shot.title+' 的模拟旁白'}))};
      else if(body.model==='local-scene')result=defaultSceneSource();
      else if(body.model==='local-vision'){
        const images=parts.filter((part:any)=>part.type==='image_url').map((part:any)=>Buffer.from(part.image_url.url.split(',')[1],'base64'));
        assert.ok(images.length>0);for(const image of images)assert.deepEqual(image.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));receipt.imageCount=images.length;receipt.imageBytes=images.reduce((sum:number,image:Buffer)=>sum+image.length,0);
        result={pass:true,issues:[],evidence:'本地协议验收已收到实际关键帧 PNG；此固定回复不构成美术质量验收。'};
      }else throw new Error('未配置的模拟文本模型');
      json({choices:[{message:{content:typeof result==='string'?result:JSON.stringify(result)},finish_reason:'stop'}]});return;
    }
    if(address.pathname==='/v1/images/generations'){assert.equal(body.model,'local-image');json({data:[{url:baseUrl+'/artifacts/image.png'}]});return;}
    if(address.pathname==='/v1/audio/speech'){assert.equal(body.model,'local-speech');assert.equal(body.voice,'fixture-voice');assert.ok(body.input.length>0);res.writeHead(200,{'Content-Type':'audio/wav'});res.end(await readFile(fixtureFiles.speech));return;}
    if(address.pathname==='/v1/media/jobs'&&req.method==='POST'){assert.equal(body.model,'local-video');const id=String(body.clientRequestId);let job=jobs.get(id);if(!job){job={jobId:id,status:'running'};jobs.set(id,job);}json(job);return;}
    if(address.pathname.startsWith('/v1/media/jobs/')&&req.method==='GET'){
      const job=jobs.get(decodeURIComponent(address.pathname.split('/').at(-1)!));assert.ok(job);job.status='succeeded';json({...job,artifacts:[{url:baseUrl+'/artifacts/video.mp4',mimeType:'video/mp4'}]});return;
    }
    if(address.pathname==='/artifacts/image.png'||address.pathname==='/artifacts/video.mp4'){
      assert.equal(req.headers.authorization,undefined);const image=address.pathname.endsWith('.png');res.writeHead(200,{'Content-Type':image?'image/png':'video/mp4'});res.end(await readFile(image?fixtureFiles.image:fixtureFiles.video));return;
    }
    json({error:'本地验收未定义此路由'},404);
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error instanceof Error?error.message:String(error)}));}
});
try{
  assert.ok(environment.browserAvailable&&environment.ffmpegAvailable&&environment.ffprobeAvailable,'验收需要真实 Chromium、FFmpeg 和 ffprobe');
  await execute(environment.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',fixtureFiles.video]);
  await execute(environment.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x49b6c7:size=320x180','-vf','drawbox=x=160:y=20:w=120:h=140:color=0xf6cc69:t=fill','-frames:v','1','-y',fixtureFiles.image]);
  await execute(environment.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=1.25','-ac','2','-c:a','pcm_s16le','-y',fixtureFiles.speech]);
  await new Promise<void>(accept=>gateway.listen(0,'127.0.0.1',accept));baseUrl='http://127.0.0.1:'+(gateway.address() as {port:number}).port;
  app=await createApplication({dataDirectory:join(temporary,'app'),credentials:new MemorySecrets()});
  async function call<T=StudioSnapshot>(endpoint:string,payload:unknown={}):Promise<T>{const write=new Set(['create','save','saveSource','export','workflows.run']);const values=payload as Record<string,unknown>;const result=await app!.route(endpoint,write.has(endpoint)?{...values,operationId:randomUUID(),...(endpoint==='create'?{expectedRevision:null}:{})}:payload);if(!result.ok)throw Object.assign(new Error(result.error.message),{code:result.error.code});return result.value as T;}
  async function configure(protocol:ModelProtocol,model:string,role:ModelRole,inputModalities:Modality[],outputModalities:Modality[],parameters:Record<string,string|number|boolean>={}){
    const connection=await call<ProviderConnection>('models.connection.save',{name:'本地验收 '+role,protocol,baseUrl:baseUrl+'/v1',auth:'bearer',apiKey:'local-fixture-only',concurrency:2});
    const definition=await call<ModelDefinition>('models.model.save',{connectionId:connection.id,model,name:role,inputModalities,outputModalities,parameters});await call('models.role.bind',{role,modelId:definition.id});
  }
  await configure('chat-completions','local-director','director',['text'],['text']);await configure('chat-completions','local-scene','scene',['text'],['text']);
  await configure('chat-completions','local-vision','vision',['text','image'],['text'],{enableVision:true,maxVisionDimension:1024});
  await configure('images','local-image','image',['text'],['image']);await configure('video-gateway','local-video','video',['text'],['video']);await configure('speech','local-speech','speech',['text'],['audio'],{voice:'fixture-voice',speed:1});
  let snapshot=await call('create',{title:'多模态协作完整成片验收'}),project=snapshot.project!;const id=project.id;const session=await call<{id:string}>('sessions.create',{projectId:id,name:'本地成片验收'});
  project.target={width:320,height:180,fps:{num:12,den:1},audioMode:'mixed',quality:'small'};project.targetDuration=6;
  project.shots.forEach((shot,index)=>{shot.durationFrames=24;shot.title=['代码镜头','生成图片镜头','生成视频镜头'][index]!;shot.params.text=shot.title;shot.params.subtitle='本地协议与真实媒体验收';shot.params.fontSize=108;shot.params.motion='none';});
  snapshot=await call('save',{projectId:id,expectedRevision:project.revision,project});await call('environment',{projectId:id,browserPath:environment.browserPath,ffmpegPath:environment.ffmpegPath,ffprobePath:environment.ffprobePath});
  passed('六类模型角色通过应用配置接口分别绑定');
  for(const [index,visual]of (['code','image','video'] as const).entries()){
    project=(await call('current',{projectId:id})).project!;const before=project.revision;
    const started=await call<WorkflowRecord>('workflows.run',{sessionId:session.id,projectId:id,expectedRevision:before,prompt:'制作 '+project.shots[index]!.title,shotIds:[project.shots[index]!.id],visual,narration:true,review:true,allowImageUpload:true,maxTasks:8});
    const complete=await waitFor(()=>call<WorkflowRecord>('workflows.get',{workflowId:started.id}),record=>record.status!=='running',visual+' 工作流');
    assert.equal(complete.status,'complete',complete.error);assert.equal(complete.committedRevision,before+1);assert.ok(complete.steps.some(step=>step.kind==='speech'&&step.status==='complete'));assert.equal(complete.steps.find(step=>step.kind==='review')?.frameEvidence?.length,1);workflows.push(complete);
    passed(visual+' 镜头完成导演、制作、已配置 Speech 和实际关键帧检查',{workflowId:complete.id,revision:complete.committedRevision});
  }
  snapshot=await call('current',{projectId:id});project=snapshot.project!;assert.equal(project.audioClips?.length,3);assert.equal(project.assets.filter(asset=>asset.kind==='image').length,1);assert.equal(project.assets.filter(asset=>asset.kind==='video').length,1);assert.equal(project.videoClips?.length,1);
  const originalVideo=project.assets.find(asset=>asset.kind==='video')!;assert.ok(originalVideo.originalPath);assert.notEqual(originalVideo.originalPath,originalVideo.path);assert.deepEqual(await readFile(join(snapshot.root!,originalVideo.originalPath!)),await readFile(fixtureFiles.video));
  const frameFiles=[];for(const [index,frame]of [12,36,60].entries()){
    const inspected=await call<{frame:{path:string;sha256:string}}>('inspect',{projectId:id,frame});
    assert.equal(inspected.frame.sha256,workflows[index]!.steps.find(step=>step.kind==='review')!.frameEvidence![0]!.sha256,'预提交候选审片应与已提交镜头实际像素一致');
    const name='shot-'+(index+1)+'.png';await copyFile(inspected.frame.path,join(output,name));frameFiles.push({frame,path:join(output,name),sha256:inspected.frame.sha256});
  }
  const beforeExport=project.revision;await call('export',{projectId:id,expectedRevision:beforeExport});snapshot=await waitFor(()=>call('current',{projectId:id}),value=>value.task?.status!=='running','实际成片导出');assert.equal(snapshot.task?.status,'complete',snapshot.task?.error);
  const film=snapshot.project!.outputs.at(-1)!;assert.equal(film.frameCount,72);assert.equal(film.duration,6);assert.equal(film.qa?.status,'PASS');assert.equal(film.qa?.audioCodec,'aac');assert.equal(film.qa?.arbitrarySeek,'PASS');assert.equal(film.qa?.coldReload,'PASS');
  const filmPath=join(output,'multimodal-film.mp4');await copyFile(film.path,filmPath);await execute(environment.ffmpegPath,['-v','error','-i',filmPath,'-f','null','-']);
  const decoded=await execute(environment.ffmpegPath,['-v','error','-i',filmPath,'-map','0:a:0','-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer',maxBuffer:2_000_000});
  const rms:number[]=[];for(const start of [.2,2.2,4.2]){let sum=0,count=0;for(let sample=Math.floor(start*48000);sample<Math.floor((start+.6)*48000);sample++){sum+=decoded.stdout.readFloatLE(sample*4)**2;count++;}rms.push(Math.sqrt(sum/count));}assert.ok(rms.every(value=>value>.01));
  passed('三种画面混排为 6 秒 72 帧 MP4，完整解码且三镜语音轨非静音',{filmPath,audioRms:rms,video:'H.264 yuv420p',audio:'AAC 48 kHz stereo'});
  const source=await call<SceneSource>('source',{projectId:id,shotId:project.shots[0]!.id}),editRevision=snapshot.project!.revision;
  const editedSource={...source,html:source.html+'<small id="continued-edit">继续编辑成功</small>',css:source.css+'\n#continued-edit{position:absolute;right:6px;bottom:6px;color:#fff;font:10px sans-serif}'};
  await call('saveSource',{projectId:id,shotId:project.shots[0]!.id,expectedRevision:editRevision,source:editedSource});snapshot=await waitFor(()=>call('current',{projectId:id}),value=>value.task?.status!=='running','后续源码编辑检查');assert.equal(snapshot.task?.status,'complete',snapshot.task?.error);assert.equal(snapshot.project!.revision,editRevision+1);assert.equal(snapshot.project!.videoClips?.length,1);assert.equal(snapshot.project!.audioClips?.length,3);assert.match((await call<SceneSource>('source',{projectId:id,shotId:project.shots[0]!.id})).html,/continued-edit/);
  passed('工作流与导出后仍可保存源码为新版本，并保留视频和三条旁白',{revision:snapshot.project!.revision});
  const speech=requests.filter(request=>request.path==='/v1/audio/speech'),vision=requests.filter(request=>request.model==='local-vision');assert.equal(speech.length,3);assert.ok(speech.every(request=>request.authenticated&&request.model==='local-speech'));assert.equal(vision.length,3);assert.ok(vision.every(request=>request.imageCount===1&&request.imageBytes!>100));assert.ok(requests.filter(request=>request.path.startsWith('/artifacts/')).every(request=>!request.authenticated));
  const media=await call<{tasks:MediaTask[]}>('media.list',{projectId:id});assert.ok(media.tasks.every(task=>task.phase==='complete'));
  passed('Speech 使用配置模型与认证，媒体下载不携带模型凭据，生成任务均已采用',{speechRequests:speech.length,imageRequests:requests.filter(request=>request.path==='/v1/images/generations').length,videoSubmissions:requests.filter(request=>request.method==='POST'&&request.path==='/v1/media/jobs').length,visionImageBytes:vision.map(request=>request.imageBytes)});
  report={...report,status:'PASS',projectId:id,film:{path:filmPath,revision:film.revision,width:film.width,height:film.height,frameCount:film.frameCount,duration:film.duration,sha256:createHash('sha256').update(await readFile(filmPath)).digest('hex'),qa:{status:film.qa!.status,codec:film.qa!.codec,pixelFormat:film.qa!.pixelFormat,fps:film.qa!.fps,audioCodec:film.qa!.audioCodec,audioStreams:film.qa!.audioStreams,sampleRate:film.qa!.sampleRate,channels:film.qa!.channels,arbitrarySeek:film.qa!.arbitrarySeek,coldReload:film.qa!.coldReload},audioRms:rms},frames:frameFiles,workflows:workflows.map(workflow=>({id:workflow.id,visual:workflow.request.visual,status:workflow.status,revision:workflow.committedRevision,steps:workflow.steps.map(step=>({kind:step.kind,status:step.status,frameEvidence:step.frameEvidence,validation:step.validation}))})),editableRevision:snapshot.project!.revision,requests};
}catch(error){report={...report,status:'FAIL',error:error instanceof Error?error.stack:String(error),requests};process.exitCode=1;console.error(error);}
finally{rendererPrototype.mediaQa=normalMediaQa;await app?.dispose();gateway.closeAllConnections();if(gateway.listening)await new Promise<void>(accept=>gateway.close(()=>accept()));await rm(temporary,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,report:join(output,'report.json'),checks:checks.length}));}
