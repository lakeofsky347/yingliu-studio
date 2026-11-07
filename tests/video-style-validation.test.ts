import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject,validateProject} from '../src/core/index.ts';
import {normalizeVideoStyle} from '../src/shared/video-style.ts';

test('projects validate custom style text while retaining a copied style snapshot',()=>{
  const project=createProject('风格校验');
  const style=normalizeVideoStyle({id:'paper',name:'纸张',prompt:'低饱和纸张纹理，慢速推镜。'});
  project.videoStyle=structuredClone(style);
  assert.equal(validateProject(project).ok,true);
  style.prompt='库中后续修改';
  assert.equal(project.videoStyle.prompt,'低饱和纸张纹理，慢速推镜。');
  project.videoStyle.prompt='x'.repeat(80001);
  assert.match(validateProject(project).errors.join('\n'),/风格描述/);
  project.videoStyle.prompt='';
  assert.equal(validateProject(project).ok,false);
});
