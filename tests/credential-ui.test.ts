import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProviderDialog} from '../src/client/ProviderDialog.tsx';
import {TtsConfig} from '../src/client/AudioPanel.tsx';
import type {ProviderSettings} from '../src/app/contracts.ts';
import type {StudioApi,StudioSnapshot} from '../src/shared/types.ts';
import type {StudioController} from '../src/client/controller.ts';

test('unreadable saved model key stays removable while new key input is unavailable',()=>{
  const initial:ProviderSettings={config:{id:'custom',name:'DeepSeek',model:'deepseek-chat',baseUrl:'https://api.deepseek.com/v1',supportsVision:false},hasKey:false,mode:'custom',credentialStatus:{available:false,backend:'basic_text',hasStoredKey:true,error:'系统钥匙环暂不可用'}};
  const html=renderToStaticMarkup(createElement(ProviderDialog,{api:{} as StudioApi,initial,onClose:()=>{},onSave:async()=>{},blocked:false}));
  assert.match(html,/系统钥匙环暂不可用/);assert.match(html,/删除已保存密钥/);
  assert.match(html,/aria-label="API Key"[^>]*disabled/);assert.doesNotMatch(html,/<button[^>]*disabled[^>]*>删除已保存密钥/);
  assert.doesNotMatch(html,/<button[^>]*disabled[^>]*>保存设置/);
});

test('unreadable speech key is removable even with a legacy unavailable speech endpoint',()=>{
  const snapshot:StudioSnapshot={project:null,root:null,task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false,platform:'linux',localSpeechAvailable:false},tts:{endpoint:'local:say',model:'',voice:'',speed:1,enabled:true},ttsConfigured:false,credentialStatus:{available:false,backend:'basic_text',hasStoredKey:true,error:'系统钥匙环暂不可用'}};
  const html=renderToStaticMarkup(createElement(TtsConfig,{snapshot,controller:{} as StudioController,busy:false}));
  assert.match(html,/清除密钥/);assert.match(html,/系统钥匙环暂不可用/);
  assert.doesNotMatch(html,/<button[^>]*disabled[^>]*>清除密钥/);
});
