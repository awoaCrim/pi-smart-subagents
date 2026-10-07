/** Offline compact/full contract tests, using real schemas/policy/registration.
 * No user settings, live catalog, selector, provider or process launch is used. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { extensionFixture } from './extension-scenarios.mjs';
import { fixtureAgents } from './surface-fixture.mjs';

const counters = ['configReads','catalogReads','toolCatalogReads','activeToolReads','registryStarts','lookups','deliveryClaims','preflights','routes','children'];
const counts = (state) => Object.fromEntries(counters.map(k=>[k,state[k]]));
const text = (result) => result.content.map(c=>c.text ?? '').join('\n');
export async function surfaceScenarios(options) {
  const { SRC, PI_ROOT, temp, theme, ok, eq, eqJson } = options;
  const require = createRequire(path.join(PI_ROOT,'package.json'));
  const outfile=path.join(temp,'surface-helpers.mjs');
  await require('esbuild').build({stdin:{contents:`import * as S from ${JSON.stringify(path.join(SRC,'src/schema.ts'))};
    import * as C from ${JSON.stringify(path.join(SRC,'src/config.ts'))};
    import * as R from ${JSON.stringify(path.join(SRC,'src/routing-policy.ts'))};
    import { Value } from 'typebox/value'; export { S,C,R,Value };`,resolveDir:path.join(PI_ROOT,'node_modules'),loader:'ts'},
    outfile,bundle:true,platform:'node',format:'esm',target:'node22',nodePaths:[path.join(PI_ROOT,'node_modules')],
    alias:{'@earendil-works/pi-tui':path.dirname(path.dirname(require.resolve('@earendil-works/pi-tui')))}});
  const {S,C,R,Value}=await import(pathToFileURL(outfile).href);
  const canonicalBefore=JSON.stringify(S.SubagentParamsSchema);
  for (const [mode,roots,items] of [['compact',16,10],['full',30,23]]) {
    const canonical=S.subagentSurfaceSchema(mode), schema=S.providerSubagentSchema(mode);
    eq(Object.keys(schema.properties).length,roots,`${mode}: exact root field count`);
    eq(Object.keys(schema.properties.tasks.items.properties).length,items,`${mode}: exact item field count`);
    eq(schema.type,'object',`${mode}: provider top-level object`);
    eq(schema.additionalProperties,false,`${mode}: closed root`);
    eq(schema.properties.tasks.items.additionalProperties,false,`${mode}: closed item`);
    ok(!JSON.stringify(schema).includes('"~'),`${mode}: recursive provider metadata removed`);
    const hasMetadata = (v) => v && typeof v==='object' && (Object.keys(v).some(k=>k.startsWith('~')) || Object.values(v).some(hasMetadata));
    ok(hasMetadata(canonical),`${mode}: canonical TypeBox metadata retained`);
    for(const legacy of ['model','fallback_models','thinking']) {
      ok(!Object.hasOwn(schema.properties,legacy) && !Object.hasOwn(schema.properties.tasks.items.properties,legacy),`${mode}: ${legacy} not advertised`);
    }
    const actions=schema.properties.action.anyOf.map(a=>a.const);
    eqJson(actions,mode==='compact'?['status','wait','cancel','steer','diff','apply','discard']:['status','wait','cancel','steer','diff','apply','discard','plan'],`${mode}: action selection`);
    ok(Value.Check(canonical,{task:'x'}),`${mode}: canonical compact input accepted`);
    ok(!Value.Check(canonical,{tasks:[{task:'x',unknown:true}]}),`${mode}: nested unknown rejected`);
    ok(!Value.Check(canonical,{task:'x',unknown:true}),`${mode}: root unknown rejected`);
    ok(!Value.Check(canonical,{tasks:[]}) && !Value.Check(canonical,{tasks:Array(9).fill({task:'x'})}),`${mode}: parallel size limits retained`);
  }
  eqJson(Object.keys(S.SubagentParamsSchema.properties).length,32,'legacy-aware canonical root retained');
  eq(Object.keys(S.ParallelTaskItem.properties).length,25,'legacy-aware canonical item retained');
  eq(JSON.stringify(S.SubagentParamsSchema),canonicalBefore,'surface construction never mutates canonical schema');
  eqJson(S.sanitizeProviderSchema(S.SubagentParamsSchema).additionalProperties,false,'canonical provider sanitizer stays closed');
  eq(Object.keys(S.ProviderSubagentWaitParamsSchema.properties).length,2,'wait alias unchanged field count');
  const outputSchema={type:'object',properties:{model:{type:'string'},tools:{type:'array',items:{type:'string'}},'~schema-test':{type:'boolean'}},required:['model','tools'],additionalProperties:false};
  const nestedOutput={task:'x',output_schema:outputSchema};
  ok(Value.Check(S.subagentSurfaceSchema('full'),nestedOutput),'full permits free-form output schema property names');
  eq(S.subagentSurfaceError(nestedOutput,'full'),undefined,'full gate never traverses JSON Schema property names');
  eqJson(nestedOutput.output_schema,outputSchema,'output schema payload not mutated');
  for(const mode of [undefined,null,1,'FULL','typo',false,{},'compact','full']) {
    eq(C.loadConfig(C.sanitizeConfigOverrides({toolMode:mode}),{}).toolMode,mode==='full'?'full':'compact',`sanitizer mode ${JSON.stringify(mode)}`);
  }
  eq(C.loadConfig({}, {PI_SUBAGENT_TOOL_MODE:'full'}).toolMode,'compact','no environment mode override');
  const fakeRouting=C.sanitizeConfigOverrides({jevRouting:{apiKey:'offline-only',selectorModel:'fixture',models:[{model:'offline/model',description:'synthetic',thinking:'high'}]}}).jevRouting;
  for (const mode of ['compact','full']) {
    const guidance=R.formatJevRoutingPrompt(fakeRouting,undefined,mode);
    ok(!guidance.includes('offline/model') && !guidance.includes('thinking default') && !guidance.includes('offline-only'),`${mode}: no candidates/thinking/key enumeration`);
    ok(guidance.includes(mode) && guidance.includes('fails closed') && guidance.includes('max_cost'),`${mode}: mode/routing/budget essentials`);
    const missing=R.formatJevRoutingPrompt(undefined,'Synthetic invalid config',mode);
    ok(missing.includes('Synthetic invalid config') && missing.includes('New work is blocked') && missing.includes('template'),`${mode}: missing config actionable`);
  }

  // Verify registration mode selection independently of session initialization.
  for(const mode of [undefined,null,1,'FULL','bad','full']) {
    const fixture=await extensionFixture({...options,toolMode:'compact',overrides:{toolMode:mode}});
    try {
      eq(fixture.state.resources,0,`factory ${JSON.stringify(mode)}: no runtime/maintenance resource`);
      eq(fixture.state.children,0,`factory ${JSON.stringify(mode)}: no process launch`);
      eq(Object.keys(fixture.tools.get('subagent').parameters.properties).length,mode==='full'?30:16,`factory ${JSON.stringify(mode)}: selected schema`);
      eq(fixture.state.configReads,1,`factory ${JSON.stringify(mode)}: one mode snapshot read`);
      const selected=mode==='full'?'full':'compact';
      const definition=fixture.tools.get('subagent');
      const schema=JSON.stringify(definition.parameters), guidance=JSON.stringify(definition.promptGuidelines);
      await fixture.start('tui',{toolMode:selected==='full'?'compact':'full'});
      eq(JSON.stringify(definition.parameters),schema,`factory ${JSON.stringify(mode)}: session_start cannot hot-switch schema`);
      eq(JSON.stringify(definition.promptGuidelines),guidance,`factory ${JSON.stringify(mode)}: session_start cannot hot-switch guidance`);
      const prompt=(await fixture.events.get('before_agent_start')({systemPrompt:'parent'},fixture.ctx)).systemPrompt;
      ok(prompt.includes(`${selected} surface`),`factory ${JSON.stringify(mode)}: session config cannot hot-switch routing guidance`);
      if(selected==='compact') {
        const before=counts(fixture.state); let error;
        try {await fixture.call({task:'mode check',output_schema:{type:'object'}});}catch(e){error=e;}
        ok(error?.message.includes('output_schema requires toolMode: "full"'),`factory ${JSON.stringify(mode)}: compact gate remains latched`);
        eqJson(counts(fixture.state),before,`factory ${JSON.stringify(mode)}: latched gate has no dispatch side effects`);
      } else {
        const run=await fixture.launch({output_schema:{type:'object'}});
        eqJson(fixture.state.pending[0].specs[0].outputSchema,{type:'object'},'factory full: advanced acceptance stays latched through session_start');
        await fixture.settle();await fixture.call({action:'wait',id:run.id});
      }
    } finally {await fixture.close();}
  }
  for (const [env,value] of [['PI_SUBAGENT_DEPTH','malformed'],['PI_SUBAGENT_SPAWNS','false']]) {
    const old=process.env[env]; process.env[env]=value;
    const fixture=await extensionFixture({...options});
    try {eq(fixture.tools.size,0,`${env}: early exit registers nothing`);eq(fixture.state.configReads,0,`${env}: early exit before mode config read`);}
    finally {await fixture.close();if(old===undefined)delete process.env[env];else process.env[env]=old;}
  }

  let history=[];
  let historicId, historicStructuredId;
  const historicTree=path.join(temp,'historic-wip','work');
  fs.mkdirSync(historicTree,{recursive:true});
  const wipArtifact=path.join(path.dirname(historicTree),'wip.patch');
  fs.writeFileSync(wipArtifact,'Synthetic historic parent WIP');
  for (const mode of ['full','compact']) {
    const trustedSchema={type:'object',properties:{model:{type:'string'}},required:['model']};
    const agents=[...fixtureAgents,{name:'trusted',description:'Trusted advanced defaults',profile:'general',systemPrompt:'Trusted instructions',outputSchema:trustedSchema,
      thinking:'max',graceTurns:4,maxRetries:3,maxTurns:12,maxCost:2,timeoutMs:8000,isolation:'worktree',tools:['write']}];
    const fixture=await extensionFixture({...options,toolMode:mode,agents,overrides:{graceTurns:5,maxRetries:2,
      taskDefaults:{general:{timeoutMs:7000,maxTurns:10,maxCost:3,maxRetries:1,thinking:'high'}}}});
    const {state,tools,events,ctx,call,start,launch,settle,entries}=fixture;
    const rejected = async (params,pattern,label,alias=false) => {
      const before=counts(state); let error;
      try {await (alias?tools.get('subagent_wait').execute('alias',params,undefined,undefined,ctx):call(params));} catch(e) {error=e;}
      ok(!!error,`${mode}: ${label} rejects`);
      ok(pattern.test(error?.message ?? ''),`${mode}: ${label} diagnostic`,error?.message);
      for(const counter of counters) eq(state[counter],before[counter],`${mode}: ${label} zero ${counter}`);
    };
    try {
      await start();
      const advertised=JSON.stringify(tools.get('subagent').parameters);
      const guidelines=JSON.stringify(tools.get('subagent').promptGuidelines);
      for(const agent of agents) ok(guidelines.includes(agent.name) && guidelines.includes(agent.description),`${mode}: catalog ${agent.name} identity/description retained`);
      // Force catalog TTL expired: any premature catalog lookup would be counted.
      state.runtime.agentsLoadedAt=0;
      if(mode==='compact') {
        const hidden={system_prompt:'',tools:[],grace_turns:0,max_retries:0,context:'fresh',output:'',output_schema:{},output_mode:'inline',resume:'',fork_resume:false,
          include_wip:false,allow_shared_writes:false,keep_background:false};
        for(const [field,value] of Object.entries(hidden)) {
          await rejected({task:'x',[field]:value},new RegExp(field+'.*full'),`hidden ${field}`);
          await rejected({tasks:[{task:'x'},{task:'y',[field]:value}]},new RegExp('tasks\\[1\\]\\.'+field+'.*full'),`mixed batch hidden ${field}`);
        }
        await rejected({tasks:[{task:'x'}],synthesis:''},/synthesis.*full/,'hidden synthesis empty');
        await rejected({action:'plan',task:'x'},/plan.*full/,'hidden plan');
      }
      for(const field of ['model','fallback_models']) {
        const value=field==='model'?'manual/model':[];
        await rejected({task:'x',[field]:value},/omit model and fallback_models/,'legacy '+field);
        await rejected({tasks:[{task:'x'},{task:'y',[field]:value}]},/tasks\[1\].*omit model/,'batch legacy '+field);
      }
      for(const params of [{task:'x',thinking:'high'},{task:'x',unknown:1},{tasks:[{task:'x',unknown:1}]},{task:'x',__waitTimeoutMs:3},{action:'status',__waitTimeoutMs:3},null,[],{action:'nonsense'}]) {
        await rejected(params,/Invalid parameters/,'unknown/malformed '+JSON.stringify(params));
      }
      for (const params of [{id:'missing',unknown:1},{id:'missing',__waitTimeoutMs:3},...['1',NaN,Infinity,0,-1,86400001,null].map(timeout_ms=>({id:'missing',timeout_ms})),{},null]) {
        await rejected(params,/Invalid wait parameters/,'raw alias '+JSON.stringify(params),true);
      }
      const waitParams={id:'missing',__waitTimeoutMs:3};
      await rejected(waitParams,/Invalid wait parameters/,'spoof alias unchanged',true);
      eq(waitParams.__waitTimeoutMs,3,`${mode}: invalid public input never mutated`);

      // Per-dispatch routing refresh must not hot-switch the selected surface.
      state.config={...state.config,toolMode:mode==='full'?'compact':'full',jevRouting:{...state.config.jevRouting,timeoutMs:12345}};
      const routingText=(await events.get('before_agent_start')({systemPrompt:'parent'},ctx)).systemPrompt;
      ok(routingText.includes(`${mode} surface`),`${mode}: before_agent_start mode stays registered`);
      eq(JSON.stringify(tools.get('subagent').parameters),advertised,`${mode}: schema latched`);
      eq(JSON.stringify(tools.get('subagent').promptGuidelines),guidelines,`${mode}: guidelines latched`);
      const simple=await launch({difficulty:'moderate',timeout_ms:5000,max_turns:6,max_cost:.5,isolation:'worktree'});
      const spec=state.pending[0].specs[0];
      eq(state.routingConfigs.at(-1).timeoutMs,12345,`${mode}: fresh routing config reaches router`);
      eqJson([spec.difficulty,spec.timeoutMs,spec.maxTurns,spec.maxCost,spec.isolation],['moderate',5000,6,.5,'worktree'],`${mode}: budgets/difficulty/isolation preserved`);
      eq(state.pending[0].options.graceTurns,5,`${mode}: configured grace preserved`);
      eq(state.pending[0].options.maxRetries,2,`${mode}: configured retries preserved`);
      eqJson([spec.keepBackground,spec.includeWip,spec.allowSharedWrites],[false,false,false],`${mode}: advanced flags never mode defaults`);
      await settle(); await call({action:'wait',id:simple.id});
      const terminal=entries.find(e=>e.data?.id===simple.id && e.data.type==='terminal');
      const blockedId=`blocked-history-${mode}`;
      entries.push({...terminal,data:{...terminal.data,id:blockedId,data:{...terminal.data.data,state:'lost',resumeBlocked:true,
        results:terminal.data.data.results.map(r=>({...r,sessionId:'blocked-session'}))}}});
      state.runtime.registry.refreshSnapshots(state.runtime.key);
      const blocked=await call({action:'status',id:blockedId});
      ok(text(blocked).includes('session blocked-session (resume blocked)'),`${mode}: specific status never calls a blocked session resumable`);
      const blockedList=await call({action:'status'});
      ok(text(blockedList).includes('session blocked- (resume blocked)'),`${mode}: status list preserves blocked resume state`);
      if(mode==='compact') await rejected({task:'x',resume:'hidden'},/full/,'mode edit cannot unlock full field');
      else {
        // Full remains full after file edits; exercise every advanced opt-in through real policy.
        state.tools=[{name:'read',description:'fixture read'}];
        const advanced=await launch({system_prompt:'extra',tools:['read'],grace_turns:0,max_retries:0,context:'fresh',output:'report.json',output_schema:outputSchema,
          output_mode:'file-only',resume:'historic-session',fork_resume:true,isolation:'worktree',include_wip:true,allow_shared_writes:true,keep_background:true});
        const advancedSpec=state.pending[0].specs[0];
        eqJson(advancedSpec.outputSchema,outputSchema,'full: nested output_schema model/tools keywords preserved to engine');
        eqJson([advancedSpec.systemPrompt,advancedSpec.tools,advancedSpec.graceTurns,advancedSpec.maxRetries,advancedSpec.outputMode,advancedSpec.resume,advancedSpec.forkResume,
          advancedSpec.includeWip,advancedSpec.allowSharedWrites,advancedSpec.keepBackground],['extra',['read'],0,0,'file-only','historic-session',true,true,true,true],'full: advanced values unchanged to engine');
        await settle('completed',{sessionId:'historic-session',outputFile:path.join(temp,'old-output.json'),structuredOutput:{model:'synthetic'},
          worktree:{cwd:historicTree,branch:'old-wip',baseCommit:'abc',changed:true,wipPatch:'parent WIP',wipUntracked:['new.txt']}});
        historicId=advanced.id;
        const inlineStructured=await launch({output_schema:outputSchema});
        await settle('completed',{sessionId:'historic-structured-session',structuredOutput:{model:'retained-json',tools:[]},
          worktree:{cwd:historicTree,branch:'old-structured',baseCommit:'abc',changed:true}});
        historicStructuredId=inlineStructured.id;
        history=JSON.parse(JSON.stringify(entries));
        state.editor=undefined; await state.adapter.resumeRun(advanced.id);
        ok(state.editor?.includes('resume: "historic-session"'),'full: adapter retains resume request');
        const starts=state.registryStarts, children=state.children;
        const plan=await call({action:'plan',tasks:[{task:'a'},{task:'b'}],synthesis:'Combine fixture results'});
        ok(plan.details.synthesis?.state==='resolved','full: synthesis plan follows existing route path');
        eq(state.registryStarts,starts,'full: plan does not register a run');eq(state.children,children,'full: plan does not start child');
        const forked=await launch({context:'fork'});
        ok(state.pending[0].specs[0].contextFork && state.pending[0].specs[0].parentSessionFile,'full: context fork reaches engine');
        await settle();await call({action:'wait',id:forked.id});
        state.tools=[];
      }

      // Named advanced defaults survive a surface restriction; no new caller escape.
      const trusted=await launch({agent:'trusted'});
      const trustedSpec=state.pending[0].specs[0];
      eqJson(trustedSpec.outputSchema,trustedSchema,`${mode}: trusted outputSchema survives`);
      eqJson([trustedSpec.systemPrompt,trustedSpec.thinking,trustedSpec.maxTurns,trustedSpec.timeoutMs,trustedSpec.maxCost,trustedSpec.graceTurns,trustedSpec.maxRetries],
        ['Trusted instructions','max',12,8000,2,4,3],`${mode}: named precedence and advanced defaults survive`);
      eqJson(trustedSpec.tools,[],`${mode}: named tool defaults do not narrow local catalog`);
      await settle();await call({action:'wait',id:trusted.id});
      const override=await launch({agent:'trusted',max_turns:2,max_cost:0,timeout_ms:6000});
      eqJson([state.pending[0].specs[0].maxTurns,state.pending[0].specs[0].maxCost,state.pending[0].specs[0].timeoutMs],[2,0,6000],`${mode}: explicit compact fields beat named defaults`);
      await settle();await call({action:'wait',id:override.id});

      // Ordinary parallel writers preserve safety; disjoint cwd/worktrees are still supported.
      state.tools=[{name:'write',description:'fixture write'}];
      const before=state.registryStarts, childCount=state.children;
      let writerError;
      try {await call({tasks:[{task:'a',profile:'general'},{task:'b',profile:'general'}]});}catch(e){writerError=e;}
      ok(writerError?.message.includes('Parallel writers share'),`${mode}: unsafe parallel writers rejected by existing policy`);
      eq(state.children,childCount,`${mode}: unsafe writers start no child`);
      eq(state.registryStarts,before+1,`${mode}: existing early-run registration remains discoverable on final-policy failure`);
      for (const tasks of [[{task:'a',profile:'general',isolation:'worktree'},{task:'b',profile:'general',isolation:'worktree'}],
        [{task:'a',profile:'general',cwd:path.join(temp,'a')},{task:'b',profile:'general',cwd:path.join(temp,'b')}], [{task:'a'},{task:'b'}]]) {
        const run=await launch({task:undefined,tasks});
        eq(state.pending[0].specs.length,2,`${mode}: ordinary parallel dispatch`);
        if(tasks.every(t=>!t.profile)) ok(state.pending[0].specs.every(t=>t.profile==='explore' && !t.canWrite),`${mode}: parallel defaults remain read-only`);
        await settle();await call({action:'wait',id:run.id});
      }
      state.tools=[];
      // Timeout and abort are non-consuming; one native-usage delivery for both entrypoints.
      const background=await launch(); const pending=state.pending[0];
      const timeout=await tools.get('subagent_wait').execute('wait',{id:background.id,timeout_ms:2},undefined,undefined,ctx);
      ok(text(timeout).includes('NOT cancelled'),`${mode}: bounded alias returns non-cancelling receipt`);
      const abort=new AbortController();abort.abort();
      await tools.get('subagent_wait').execute('wait',{id:background.id},abort.signal,undefined,ctx);
      ok(!pending.options.signal.aborted,`${mode}: alias abort does not cancel run`);
      eq(state.runtime.registry.lookup(background.id,state.runtime.key).run.delivered,false,`${mode}: timeout/abort do not consume`);
      await settle();
      const simultaneous=await Promise.all([call({action:'wait',id:background.id}),tools.get('subagent_wait').execute('wait',{id:background.id},undefined,undefined,ctx)]);
      eq(simultaneous.filter(r=>r.usage).length,1,`${mode}: management/alias concurrent delivery has one usage winner`);

      if(mode==='compact') {
        // Import historical full-mode persistence into compact; mode is not a data filter.
        entries.push(...history);state.runtime.registry.refreshSnapshots(state.runtime.key);
        const old=await call({action:'status',id:historicId});
        ok(text(old).includes('historic-session') && text(old).includes('full mode + reload'),'compact: status retains old session pointer and qualifies resume');
        eqJson(old.details.results[0].structuredOutput,{model:'synthetic'},'compact: old structured output retained');
        eq(old.details.results[0].outputFile,path.join(temp,'old-output.json'),'compact: old artifact pointer retained');
        const inlineDiff=await call({action:'diff',id:historicStructuredId});
        ok(text(inlineDiff).includes('evidence-300'),'compact: inline historical structured result cannot mask diff evidence');
        eqJson(inlineDiff.details.results[0].structuredOutput,{model:'retained-json',tools:[]},'compact: diff retains original structured details');
        const inlineDelivery=await tools.get('subagent_wait').execute('old-inline',{id:historicStructuredId},undefined,undefined,ctx);
        eqJson(JSON.parse(text(inlineDelivery)),{model:'retained-json',tools:[]},'compact: wait after diff still delivers original JSON');
        state.editor=undefined;await state.adapter.resumeRun(historicId);
        ok(!state.editor && fixture.notices.at(-1)[0].includes('toolMode: "full"'),'compact: adapter does not prepare unavailable resume call');
        let steerError;
        try {await call({action:'steer',id:historicId,message:'follow up'});}catch(e){steerError=e;}
        ok(steerError?.message.includes('Resume requires toolMode: "full"'),'compact: finished steer explains full mode rather than unavailable call');
        state.adapter.showOutput(historicId);
        ok(state.editor.includes('historic-session') && state.editor.includes('old-output.json'),'compact: output command keeps all historical pointers');
        const manageable=await launch();
        const managedChild=state.pending[0];
        state.runtime.liveRunners.set(manageable.id,new Map([[0,{steer:()=>true}]]));
        for (const routing of [undefined,{invalid:true}]) {
          state.runtime.config=C.loadConfig(C.sanitizeConfigOverrides({jevRouting:routing}),{});
          state.config={toolMode:'full',jevRouting:routing};
          const routes=state.routes, configReads=state.configReads;
          const still=await call({action:'status',id:historicId});ok(text(still).includes('historic-session'),'compact: broken routing does not strand status');
          const diff=await call({action:'diff',id:historicId});ok(text(diff).includes('Worktree diff') && text(diff).includes('evidence-300'),'compact: old structured WIP run exposes actual diff evidence');
          eqJson(diff.details.results[0].structuredOutput,{model:'synthetic'},'compact: diff evidence does not erase historical structured details');
          eq(state.diffs.at(-1).cwd,historicTree,'compact: WIP worktree reaches unchanged management boundary');
          ok(fs.existsSync(wipArtifact),'compact: stored WIP artifact preserved by management');
          const apply=await call({action:'apply',id:historicId});ok(text(apply).includes('uncommitted'),'compact: old WIP worktree apply available');
          eq(state.routes,routes,'compact: management never routes with broken config');
          const steering=await call({action:'steer',id:manageable.id,message:'Fixture guidance'});
          ok(text(steering).includes('queued'),'compact: broken Jev permits live steer');
          eq(state.configReads,configReads,'compact: management never reads dispatch config');
          const starts=state.registryStarts, preflights=state.preflights, children=state.children;
          let unavailable;
          try {await call({task:'Blocked by broken routing'});}catch(e){unavailable=e;}
          ok(!!unavailable,'compact: broken Jev still blocks new work');
          eq(state.routes,routes,'compact: invalid routing calls no selector');
          eqJson([state.registryStarts,state.preflights,state.children],[starts,preflights,children],'compact: missing routing starts no new work');
        }
        const cancel=await call({action:'cancel',id:manageable.id});ok(text(cancel).includes('requested') && managedChild.options.signal.aborted,'compact: broken routing permits cancellation');
        await settle('cancelled');
        const finished=await tools.get('subagent_wait').execute('managed',{id:manageable.id},undefined,undefined,ctx);
        ok(finished.details.results.length===1,'compact: broken routing permits wait');
        const collected=await tools.get('subagent_wait').execute('old',{id:historicId},undefined,undefined,ctx);
        ok(collected.details.results[0].outputFile,'compact: old file-only delivery available');
        const discarded=await call({action:'discard',id:historicId});ok(text(discarded).includes('Discarded worktree'),'compact: historical worktree discard available');
        fs.rmSync(historicTree,{recursive:true,force:true});
        const archivedPatch=historicTree+'.patch'; fs.writeFileSync(archivedPatch,'ARCHIVED-PATCH-SENTINEL');
        const archived=await call({action:'diff',id:historicId});
        ok(text(archived).includes('ARCHIVED-PATCH-SENTINEL'),'compact: archived structured run diff returns patch, not JSON result');
        eqJson(archived.details.results[0].structuredOutput,{model:'synthetic'},'compact: archived diff retains historical structured details');
        eqJson(state.runtime.registry.lookup(historicId,state.runtime.key).run.results[0].structuredOutput,{model:'synthetic'},'compact: archived diff never mutates persisted result');
        const archivedApply=await call({action:'apply',id:historicId});ok(text(archivedApply).includes('uncommitted'),'compact: archived patch apply remains available');
        await call({action:'discard',id:historicId});ok(!fs.existsSync(archivedPatch),'compact: archived patch discard remains available');
      }
    } finally {await fixture.close();}
  }
}
