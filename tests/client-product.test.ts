import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../src/core/index.ts';
import { addPlacedShot, briefPayload, outputPositionWithoutOverlap } from '../src/client/project-ui.ts';
import { RenderWatchdog } from '../src/client/preview-watchdog.ts';

test('creation brief validates before creating and carries actual user output settings',()=>{
  const brief={title:'  新影片  ',topic:'真实主题',duration:24,profile:'social-vertical',preset:'evidence-window',mode:'ai' as const},value=briefPayload(brief);assert.equal(value.title,'新影片');assert.equal(value.blank,true);assert.equal(value.target.width,1080);assert.equal(value.target.height,1920);assert.equal(value.targetDuration,24);assert.equal(value.preset,'evidence-window');assert.throws(()=>briefPayload({...brief,topic:''}),/主题/);assert.throws(()=>briefPayload({...brief,duration:0}),/片长/);assert.throws(()=>briefPayload({...brief,profile:'unknown'}),/规格/);assert.doesNotThrow(()=>briefPayload({...brief,mode:'blank',topic:''}));
});
test('adding nodes to an empty graph keeps shots and the output node apart',()=>{
  let project=createProject('空图');project={...project,shots:[],shotOrder:[],graph:{positions:{'film-output':[100,140]},groups:[]}};const first=addPlacedShot(project),firstShot=first.shots[0]!,shotPosition=first.graph.positions[firstShot.id]!,outputPosition=first.graph.positions['film-output']!;assert.ok(Math.abs(outputPosition[0]-shotPosition[0])>=300);assert.equal(project.shots.length,0);
  const second=addPlacedShot(first,firstShot.id),added=second.shots.find(shot=>shot.id!==firstShot.id)!;assert.notDeepEqual(second.graph.positions[added.id],shotPosition);assert.ok(Math.abs(second.graph.positions['film-output']![0]-second.graph.positions[added.id]![0])>=300);
});
test('render timeout cannot be postponed indefinitely by subsequent render requests',async()=>{
  let timedOut=0;const guard=new RenderWatchdog(()=>timedOut++,35);guard.arm();await new Promise(resolve=>setTimeout(resolve,20));guard.arm();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(timedOut,1);guard.dispose();
});
test('received frames and teardown cancel the render timeout',async()=>{
  let timedOut=0;const guard=new RenderWatchdog(()=>timedOut++,20);guard.arm();guard.acknowledge();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(timedOut,0);guard.arm();guard.dispose();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(timedOut,0);
});


test('AI shots inheriting an empty graph output position remain visually distinct',()=>{
  const shots=[{position:[375,100] as [number,number],size:[252,242] as [number,number]},{position:[705,100] as [number,number],size:[252,242] as [number,number]},{position:[1035,100] as [number,number],size:[252,242] as [number,number]}];
  assert.deepEqual(outputPositionWithoutOverlap([375,100],shots),[1357,100]);assert.deepEqual(outputPositionWithoutOverlap([1600,100],shots),[1600,100]);assert.deepEqual(outputPositionWithoutOverlap([10,100],[]),[10,100]);
  // Tall nodes with multiple material ports need rectangle collision checks.
  assert.deepEqual(outputPositionWithoutOverlap([750,320],[{position:[705,100],size:[252,450]}]),[1027,100]);
});
