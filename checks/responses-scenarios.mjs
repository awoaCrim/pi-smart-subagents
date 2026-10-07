/** Offline real Responses serializer + registered hook regression. No provider calls. */
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {extensionFixture} from './extension-scenarios.mjs';

const model={provider:'offline',id:'fixture-model',name:'Offline fixture',api:'openai-responses',baseUrl:'https://offline.invalid/v1',
  reasoning:false,input:['text'],contextWindow:8192,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const freeze=(value)=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

export async function responsesScenarios(options){
  const {PI_ROOT,ok,eq,eqJson}=options;
  const ai=path.join(PI_ROOT,'node_modules/@earendil-works/pi-ai/dist');
  const {stream}=await import(pathToFileURL(path.join(ai,'api/openai-responses.js')).href);
  const {normalizeContext}=await import(pathToFileURL(path.join(ai,'utils/transcript.js')).href);
  let networkCalls=0;
  for(const toolMode of ['compact','full']){
    const fixture=await extensionFixture({...options,toolMode});
    try{
      const hook=fixture.events.get('before_provider_request');
      ok(typeof hook==='function',`${toolMode}: production registers Responses declaration hook`);
      if(!hook)continue; // Baseline fails here, before any mocked implementation can hide the defect.
      fixture.ctx.model=model;
      const definitions=[...fixture.tools.values()].map(({name,description,parameters})=>({name,description,parameters}));
      const registeredBefore=JSON.stringify(definitions);
      const counts=()=>JSON.stringify(Object.fromEntries(['configReads','catalogReads','registryStarts','preflights','routes','children'].map(k=>[k,fixture.state[k]])));
      const beforeCounts=counts();
      async function capture(withHook,requestModel=model){
        let payload;
        const result=await stream(requestModel,normalizeContext({systemPrompt:'Offline declaration test only.',tools:definitions,
          messages:[{role:'user',content:'No execution.',timestamp:0}]}),{
          apiKey:'offline-not-a-secret',maxTokens:16,maxRetries:0,
          fetch:async()=>{networkCalls++;throw Error('Network forbidden');},
          onPayload:async current=>{payload=structuredClone(withHook?await hook({payload:current,type:'before_provider_request'},fixture.ctx)??current:current);throw Error('Intentional offline capture');},
        }).result();
        ok(result.errorMessage?.includes('Intentional offline capture'),`${toolMode}: capture aborts before HTTP`);
        return payload;
      }
      const original=await capture(false),patched=await capture(true);
      ok(original.tools.every(t=>!Object.hasOwn(t,'strict')),`${toolMode}: actual host counterfactual omits strict`);
      ok(patched.tools.every(t=>t.strict===false),`${toolMode}: actual host plus production hook emits false`);
      eqJson(patched,{...original,tools:original.tools.map(t=>({...t,strict:false}))},`${toolMode}: strict is the only serialized difference`);
      eq(counts(),beforeCounts,`${toolMode}: request hook has no dispatch/config/catalog side effects`);
      eq(JSON.stringify(definitions),registeredBefore,`${toolMode}: registered canonical projections not mutated`);

      const unrelated={type:'function',name:'other',parameters:{type:'object',properties:{x:{type:'string'}}},strict:true};
      const historical={type:'tool_search_output',tools:original.tools};
      const payload=freeze({...original,metadata:{keep:false},input:[historical,{type:'function_call',name:'subagent',arguments:'{"task":"x","tasks":[]}'}],tools:[...original.tools,unrelated]});
      const result=await hook({payload},fixture.ctx);
      ok(result!==payload&&result.tools!==payload.tools,`${toolMode}: frozen payload copied on change`);
      eq(result.input,payload.input,`${toolMode}: historical tools and argument text untouched`);
      eq(result.metadata,payload.metadata,`${toolMode}: unrelated fields retain identity`);
      eq(result.tools.at(-1),unrelated,`${toolMode}: unrelated tool retains identity`);
      for(let i=0;i<original.tools.length;i++)eq(result.tools[i].parameters,payload.tools[i].parameters,`${toolMode}: schema reference retained ${i}`);
      eq(await hook({payload:result},fixture.ctx),undefined,`${toolMode}: repeated request correction no-op`);
      for(const strict of [true,false,null,undefined,'invalid']){
        const existing={...original,tools:original.tools.map(t=>({...t,strict}))};
        eq(await hook({payload:existing},fixture.ctx),undefined,`${toolMode}: present strict ${String(strict)} preserved`);
      }
      const wrongTools=[null,[],{type:'namespace',name:'subagent',tools:original.tools},{type:'custom',name:'subagent'},
        {...original.tools[0],defer_loading:true},{...original.tools[0],parameters:{type:'string'}},
        {...original.tools[0],parameters:{type:'object',additionalProperties:true}},unrelated];
      eq(await hook({payload:{...original,tools:wrongTools}},fixture.ctx),undefined,`${toolMode}: non-owned/non-direct/malformed definitions no-op`);
      for(const value of [undefined,null,[],{}, {...original,input:null},{...original,tools:null},{...original,model:'other-model'}]){
        eq(await hook({payload:value},fixture.ctx),undefined,`${toolMode}: unknown/mismatched payload no-op`);
      }
      for(const selected of [undefined,null,{}, {...model,api:'virtual'},{...model,api:'openai-codex-responses'},
        {...model,api:'openai-completions'},{...model,id:'other-model'}, {...model,compat:{supportsStrictMode:false}},
        {...model,compat:{supportsStrictMode:null}}, {...model,compat:{supportsStrictMode:'true'}}, {...model,compat:'invalid'}]){
        fixture.ctx.model=selected;
        eq(await hook({payload:original},fixture.ctx),undefined,`${toolMode}: unsupported selected metadata no-op`);
      }
      fixture.ctx.model={...model,compat:{supportsStrictMode:true}};
      const emitted=await capture(false,fixture.ctx.model);
      ok(emitted.tools.every(t=>t.strict===false),`${toolMode}: supported host already emits false`);
      eq(await hook({payload:emitted},fixture.ctx),undefined,`${toolMode}: supported host unchanged`);
      fixture.ctx.model=model;
      ok((await hook({payload:original},fixture.ctx))?.tools.every(t=>t.strict===false),`${toolMode}: per-request model switch observed`);
      eq(JSON.stringify(definitions),registeredBefore,`${toolMode}: all guard cases preserve registered schema`);
    }finally{await fixture.close();}
  }
  eq(networkCalls,0,'Responses fixture makes zero network calls');
}
