import test from 'node:test';
import assert from 'node:assert/strict';
import {fromAi} from './runtime.mjs';
import {projectForCount,visibleBasis,COUNTING_RULE} from '../src/projection_v1.4.3.mjs';
import {opaqueBasis,createCalibration,modelKey,CALIBRATION_TYPE} from '../src/calibration_v1.4.3.mjs';
import {createCalibration as legacyCalibration} from '../src/calibration.mjs';
import {createCounter,DEFAULT_POLICY as policy} from '../src/window.mjs';
const {convertResponsesMessages}=await fromAi('api/openai-responses-shared.js');
const counter=createCounter();
const a={provider:'openai',api:'openai-responses',id:'gpt-6.1-sol',input:['text']},b={...a,provider:'openai-codex',api:'openai-codex-responses'};
const signature=JSON.stringify({type:'reasoning',id:'rs_fixture',encrypted_content:'synthetic-fixture-not-real',summary:[]});
const message=(content,output=153201)=>({role:'assistant',provider:a.provider,api:a.api,model:a.id,timestamp:1,content,usage:{output},stopReason:'stop'});
const textOnWire=items=>items.filter(i=>i.type==='message').flatMap(i=>i.content??[]).filter(c=>c.type==='output_text').map(c=>c.text);
const providers=new Set(['openai','openai-codex']);
test('Responses counting projection matches real SDK serialized thinking for provider/API/model changes and redacted/empty/unsigned cases',()=>{
 for(const target of[a,b,{...a,api:'openai-codex-responses'},{...a,id:'another-model'},{...a,api:'azure-openai-responses'}])for(const block of[
  {type:'thinking',thinking:'Visible summary',thinkingSignature:signature},
  {type:'thinking',thinking:'',thinkingSignature:signature},
  {type:'thinking',thinking:'   ',thinkingSignature:signature},
  {type:'thinking',thinking:'Never reveal redacted summary',thinkingSignature:signature,redacted:true},
  {type:'thinking',thinking:'Unsigned summary'},
 ]){
  const m=message([block,{type:'text',text:'Public assistant text'}]),before=JSON.stringify(m);
  const projected=projectForCount(m,target),wire=convertResponsesMessages(target,{messages:[m]},providers);
  assert.deepEqual(projected.content.filter(c=>c.type==='text').map(c=>c.text),textOnWire(wire));
  assert.equal(projected.content.some(c=>c.type==='thinking'),wire.some(i=>i.type==='reasoning'));
  assert.equal(JSON.stringify(m),before,'Raw history/signature must not change');
 }
});
test('foreign opaque output no longer inflates basis; same route retains original-output reserve and unknown API stays conservative',()=>{
 const m=message([{type:'thinking',thinking:'Summary',thinkingSignature:signature},{type:'text',text:'Retained task'}]);
 assert.equal(opaqueBasis(m,counter,a),153201);
 assert.equal(opaqueBasis(m,counter,b),counter.tokens(projectForCount(m,b)));
 assert.equal(opaqueBasis(m,counter,{...b,api:'custom-unknown-api'}),153201);
 const unknown={...m,usage:{output:0}};assert.equal(opaqueBasis(unknown,counter,a),Infinity);assert(Number.isFinite(opaqueBasis(unknown,counter,b)));assert.equal(opaqueBasis(unknown,counter,{...b,api:'custom'}),Infinity);
 const empty=message([{type:'thinking',thinking:'',thinkingSignature:signature}]);assert.equal(visibleBasis(empty,counter,b),0);assert.equal(opaqueBasis(empty,counter,b),0);
});
test('unaudited host uses conservative basis and cannot ingest projected-rule samples',()=>{
 const key=modelKey(b),cal=createCalibration({responsesProjection:false}),m=message([{type:'thinking',thinking:'Foreign summary',thinkingSignature:signature}]);const budget=cal.view(key,counter,policy);assert.equal(budget.basis([m]),153201);assert.notEqual(budget.countingRule,COUNTING_RULE);
 const reply={role:'assistant',provider:b.provider,api:b.api,model:b.id,stopReason:'stop',content:[{type:'text',text:'Fixture'}],usage:{input:20000,cacheRead:0,cacheWrite:0,output:50}};
 const projected=createCalibration().observe({requestId:'r',modelKey:key,countingRule:COUNTING_RULE,inputFingerprint:'a'.repeat(64),visibleInputTokens:10000,basisTokens:10000},reply,key,'response');cal.restore([{id:'response',type:'message',message:reply},{id:'record',type:'custom',customType:CALIBRATION_TYPE,data:projected}]);assert.equal(cal.view(key,counter,policy).samples,0);assert.equal(cal.view(key,counter,policy).describe().incompatibleRuleSamplesIgnored,1);
});

test('counting-only projection does not change canonical tool-call/result IDs, user text or signature bytes',()=>{
 const messages=[message([{type:'thinking',thinking:'Summary',thinkingSignature:signature},{type:'toolCall',id:'call_fixture|fc_fixture',name:'read',arguments:{path:'fixture'},thoughtSignature:'immutable-fixture'}]),{role:'toolResult',toolCallId:'call_fixture|fc_fixture',toolName:'read',content:[{type:'text',text:'Tool output'}]},{role:'user',content:'Keep this task'}];
 const original=JSON.stringify(messages);const projected=messages.map(m=>projectForCount(m,b));assert.equal(projected[0].content.find(c=>c.type==='toolCall').id,messages[0].content[1].id);assert.equal(projected[1].toolCallId,messages[1].toolCallId);assert.equal(projected[2],messages[2]);assert.equal(JSON.stringify(messages),original);
});
test('valid legacy v1 records retain binding validation but never train v2; v2 route/rule stays isolated across restart',()=>{
 const key=modelKey(a),old=legacyCalibration(),newCal=createCalibration();
 const snapshot={requestId:'fixture',modelKey:key,inputFingerprint:'a'.repeat(64),visibleInputTokens:10000,basisTokens:10000};
 const response={role:'assistant',provider:a.provider,api:a.api,model:a.id,content:[{type:'text',text:'Fixture'}],stopReason:'stop',usage:{input:20000,cacheRead:0,cacheWrite:0,output:100,totalTokens:20100}};
 const v1=old.observe(snapshot,response,key,'r');assert.equal(v1.version,1);
 const branch=[{id:'r',type:'message',message:response},{id:'legacy',type:'custom',customType:CALIBRATION_TYPE,data:v1}],before=JSON.stringify(branch);
 newCal.restore(branch);assert.equal(newCal.view(key,counter,policy).samples,0);assert.equal(newCal.view(key,counter,policy).factor,1.05);assert.equal(newCal.view(key,counter,policy).describe().legacySamplesIgnored,1);assert.equal(JSON.stringify(branch),before);
 assert.equal(newCal.observe(snapshot,response,key,'r'),null,'Unversioned snapshot cannot train');
 const v2=newCal.observe({...snapshot,countingRule:COUNTING_RULE},response,key,'r');assert.equal(v2.version,2);assert.equal(v2.countingRule,COUNTING_RULE);
 newCal.restore([...branch,{id:'v2',type:'custom',customType:CALIBRATION_TYPE,data:v2}]);assert.equal(newCal.view(key,counter,policy).samples,1);assert.equal(newCal.view(modelKey(b),counter,policy).samples,0);
 assert.throws(()=>newCal.restore([{...branch[0],message:{...response,usage:{...response.usage,input:1}}},branch[1]]),/binding/);
 assert.throws(()=>newCal.restore([...branch,{id:'bad',type:'custom',customType:CALIBRATION_TYPE,data:{...v2,countingRule:'unknown'}}]),/Invalid/);
});
