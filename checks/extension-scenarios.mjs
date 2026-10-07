/** Real extension registration/execution with provider, filesystem ownership and
 * process-launch boundaries replaced by deterministic fakes. Used by render-harness.
 * No production exports or runtime switches are added for testing. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let stateId = 0;
export async function extensionFixture({ SRC, PI_ROOT, temp, theme, toolMode = 'compact', agents = [], overrides = {} }) {
  const require = createRequire(path.join(PI_ROOT, 'package.json'));
  const esbuild = require('esbuild');
  const state = { pending: [], runtime: undefined, config: {}, agents, widgetInstalls: 0, renders: 0,
    configReads: 0, catalogReads: 0, toolCatalogReads: 0, activeToolReads: 0, registryStarts: 0, lookups: 0, deliveryClaims: 0,
    preflights: 0, routes: 0, children: 0, resources: 0, routingConfigs: [], diffs: [] };
  globalThis.__subagentHarness = state;
  const source = (name) => path.join(SRC, 'src', name);
  const mocks = {
    'config.js': `import { sanitizeConfigOverrides } from ${JSON.stringify(source('config.ts'))};
      export * from ${JSON.stringify(source('config.ts'))};
      export const readConfigFile = async () => { const s=globalThis.__subagentHarness; s.configReads++; return sanitizeConfigOverrides(s.config,'offline-fixture'); };`,
    'agents.js': `export { describeCatalog } from ${JSON.stringify(source('agents.ts'))};
      export const discoverAgents=()=>{ const s=globalThis.__subagentHarness; s.catalogReads++; return new Map(s.agents.map(a=>[a.name,a])); };`,
    'launch.js': `export const createGetPiCommand=()=>()=>{throw Error('No process launches in harness')}; export const getLaunchResolution=()=>({});`,
    'process-lock.js': `export const runRecordSessionIds=()=>[]; export class ProcessLockManager {
      constructor(){globalThis.__subagentHarness.resources++}
      reconcileOrphans=async()=>({reaped:[],alreadyDead:[]}); sweep(){} listRunRecords(){return []} dispose(){}
      acquireSessionLock(){return {ok:true}} releaseSessionLock(){} checkResumeAvailability(){return {status:'available'}}
    }`,
    'worktree.js': `export class WorktreeManager { constructor(){globalThis.__subagentHarness.resources++} sweepAll=async()=>{}; isGitRepo=async()=>true;
      archivedPatchPathFor=(cwd)=>cwd+'.patch';
      diff=async(tree)=>{ globalThis.__subagentHarness.diffs.push(tree); return {stat:'a.ts | 450 +',patch:Array.from({length:450},(_,i)=>'+ evidence-'+i).join('\\n'),truncated:false}; };
      apply=async()=>({applied:true,stat:'a.ts | 2 +',warning:'Review staged changes'});
      applyArchivedPatch=async()=>({applied:true,stat:'archived.ts | 2 +'});
      forceRemove=async()=>{};
    }`,
    'distill.js': `export const sweepSessionsLifecycle=async()=>{};`,
    'dispatch-preflight.js': `export const runLocalPreflights=async()=>{globalThis.__subagentHarness.preflights++};`,
    'jev-router.js': `export class JevRouter { constructor({config}){globalThis.__subagentHarness.routingConfigs.push(config)} }`,
    'dispatch-routing.js': `import { finalizeRoutedTasks } from ${JSON.stringify(source('policy.ts'))};
      export const routePreparedTasks=async(tasks,catalog)=>{ globalThis.__subagentHarness.routes++;
        const resolved=finalizeRoutedTasks(tasks,tasks.map(()=>({selectedModel:catalog.models[0].model,confidence:1,
          rankedModels:catalog.models.map((m,i)=>({model:m.model,probability:i===0?1:0}))})),catalog.models);
        if(!resolved.ok) throw Error(resolved.error); return resolved.tasks; };`,
    'orchestrator.js': `export const runTasks=(specs, options)=>new Promise((resolve,reject)=>{
      const s=globalThis.__subagentHarness; s.children++; s.pending.push({specs,options,resolve,reject});
    });`,
  };
  const outfile = path.join(temp, `extension-integration-${toolMode}-${stateId++}.mjs`);
  await esbuild.build({
    entryPoints: [source('extension.ts')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
    nodePaths: [path.join(PI_ROOT, 'node_modules')],
    alias: { '@earendil-works/pi-tui': path.dirname(path.dirname(require.resolve('@earendil-works/pi-tui'))) },
    plugins: [{ name: 'offline-boundaries', setup(build) {
      build.onResolve({ filter: /@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'host', namespace: 'offline' }));
      build.onResolve({ filter: /\.js$/ }, (args) => {
        const name = path.basename(args.path);
        if (path.basename(args.importer) === 'extension.ts' && mocks[name]) return { path: name, namespace: 'offline' };
      });
      build.onLoad({ filter: /.*/, namespace: 'offline' }, (args) => ({
        contents: args.path === 'host' ? `export const keyHint=()=> 'test-key to expand';` : mocks[args.path],
        resolveDir: path.join(SRC, 'src'), loader: 'ts',
      }));
      build.onLoad({ filter: /extension\.ts$/ }, (args) => {
        // Capture the closure-owned runtime for observation/seeding only. All
        // registered callbacks and execute paths stay the production code.
        const contents = fs.readFileSync(args.path, 'utf8').replace(/    current = runtime;\r?\n/, '    current = runtime; globalThis.__subagentHarness.runtime = runtime; globalThis.__subagentHarness.adapter = makeAdapter(runtime, toolMode);\n');
        return { contents, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    }}],
  });
  const register = (await import(pathToFileURL(outfile).href)).default;
  const keepAlive = setInterval(() => {}, 1000);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Network is forbidden in the offline harness'); };
  const entries = [], messages = [], notices = [], tools = new Map(), commands = new Map(), events = new Map(), renderers = new Map(), entryRenderers = new Map();
  let mounted;
  const ctx = {
    cwd: temp, hasUI: true, mode: 'tui', modelRegistry: { getAvailable: () => [{ provider: 'offline', id: 'model' }] },
    sessionManager: { getSessionFile: () => path.join(temp, 'parent.jsonl'), getSessionId: () => 'parent', getBranch: () => entries },
    ui: {
      theme, setStatus() {}, notify: (...args) => notices.push(args),
      setWidget(_key, value) {
        state.widgetInstalls++;
        mounted?.dispose?.();
        mounted = typeof value === 'function' ? value({ requestRender() { state.renders++; }, terminal: { rows: 24 } }, theme) : value;
      },
      input: async () => '', confirm: async () => false, setEditorText(text) { state.editor = text; },
    },
  };
  const pi = {
    on: (name, handler) => events.set(name, handler), registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    registerEntryRenderer: (name, renderer) => entryRenderers.set(name, renderer),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
    getAllTools: () => { state.toolCatalogReads++; return state.tools ?? []; },
    getActiveTools: () => { state.activeToolReads++; return (state.tools ?? []).map(t=>t.name); }, getThinkingLevel: () => 'off',
  };
  const config = { sessionDir: temp, worktreeDir: temp, lockDir: temp, toolMode,
    jevRouting: { apiKey: 'offline-fixture', selectorModel: 'fixture', timeoutMs: 15000, models: [{ model: 'offline/model', description: 'offline only' }] }, ...overrides };
  const start = async (mode = 'tui', overrides = {}) => {
    ctx.mode = mode; state.config = { ...config, ...overrides }; entries.length = messages.length = notices.length = 0;
    await events.get('session_start')({}, ctx);
    for (const [name,counter] of [['start','registryStarts'],['lookup','lookups'],['markDelivered','deliveryClaims']]) {
      const original=state.runtime.registry[name].bind(state.runtime.registry);
      state.runtime.registry[name]=(...args)=>{ state[counter]++; return original(...args); };
    }
    return state.runtime;
  };
  const call = (params, signal) => tools.get('subagent').execute('test', params, signal, undefined, ctx);
  const render = (result, expanded = false, isError = false, width = 80) => tools.get('subagent').renderResult(result, { expanded, isPartial: false }, theme, { state: {}, isError }).render(width);
  const settle = async (stateName = 'completed', extra = {}) => {
    const pending = state.pending.shift();
    if (!pending) throw Error('Expected a pending offline child');
    const results = pending.specs.map((spec, index) => ({
      ...spec, index, state: stateName, exitCode: stateName === 'failed' ? 1 : 0, messages: [], stderr: '',
      usage: { input: 120, output: 30, cacheRead: 2, cacheWrite: 0, cost: 0.42, contextTokens: 50, turns: 3 },
      liveText: 'Found two issues.', finalOutput: 'Found two issues.', ...extra,
    }));
    pending.resolve({ mode: results.length > 1 ? 'parallel' : 'single', state: stateName, results, summary: 'Found two issues.' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return results;
  };
  const launch = async (extra = {}) => {
    const result = await call({ task: 'Offline check', description: 'Fixture review', async: true, ...extra });
    return { result, id: result.details.id };
  };
  state.config = config;
  const oldTimeout = globalThis.setTimeout, oldInterval = globalThis.setInterval;
  globalThis.setTimeout = globalThis.setInterval = () => { throw Error('Extension factory must not start timers'); };
  try {
    await register(pi);
  } catch (error) { clearInterval(keepAlive); globalThis.fetch = oldFetch; delete globalThis.__subagentHarness; throw error; }
  finally { globalThis.setTimeout = oldTimeout; globalThis.setInterval = oldInterval; }
  const close = async () => {
    try { await events.get('session_shutdown')?.({}, ctx); } finally {
      clearInterval(keepAlive); globalThis.fetch = oldFetch; delete globalThis.__subagentHarness;
    }
  };
  return { state, entries, messages, notices, tools, commands, events, renderers, ctx, start, call, render, settle, launch, close,
    get mounted() { return mounted; } };
}

export async function extensionScenarios(options) {
  const { theme, TUI, ok, eq, eqJson, temp } = options;
  const fixture = await extensionFixture({ ...options, toolMode: 'full' });
  const { state, entries, messages, notices, tools, commands, events, renderers, ctx, start, call, render, settle, launch } = fixture;
  try {
    ok(tools.has('subagent') && tools.has('subagent_wait'), 'real extension registers both tools');
    await start();
    const first = await launch();
    ok(render(first.result).join('\n').includes('Started in background'), 'execute async-start carries startup treatment');
    ok(!render(first.result).join('\n').includes('✓ done'), 'async-start never implies child completed');
    // Background membership is added after the initial registry event. Give its
    // coalesced checkpoint a chance to mount the widget, then keep it unchanged.
    const pending = state.pending[0];
    pending.options.onTaskProgress(0, { state: 'running', liveText: 'reading files' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const component = fixture.mounted, installs = state.widgetInstalls, repaints = state.renders;
    ctx.ui.theme = { ...theme, fg: (_token, text) => `\u001b[31m${text}\u001b[39m` };
    ok(component.render(80).some((line) => line.includes('\u001b[31m')), 'mounted widget picks up a replaced host theme');
    ctx.ui.theme = theme;
    ok(component && typeof component.render === 'function', 'actual extension installs a component widget');
    await new Promise((resolve) => setTimeout(resolve, 550));
    eq(fixture.mounted, component, 'host widget identity survives two timer ticks');
    eq(state.widgetInstalls, installs, 'repaint does not reinstall/dispose widget');
    ok(state.renders >= repaints + 2 && component.render(80).length > 0, 'widget remains visible while repainting');
    const status = await call({ action: 'status', id: first.id });
    const oldNow = Date.now;
    let early, late;
    try { Date.now = () => 9e12; early = render(status); Date.now = () => 10e12; late = render(status); } finally { Date.now = oldNow; }
    eqJson(early, late, 'real status result remains frozen on later render');
    state.runtime.liveRunners.set(first.id, new Map([[0, { steer: () => true }]]));
    const steering = render(await call({ action: 'steer', id: first.id, message: 'Guidance' }), true).join('\n');
    ok(steering.includes('queued') && !steering.includes('reading files'), 'execute steer reports receipt instead of activity');
    const waitTimed = await tools.get('subagent_wait').execute('w', { id: first.id, timeout_ms: 5 }, undefined, undefined, ctx);
    ok(render(waitTimed).join('\n').includes('timed out'), 'alias executes shared bounded-wait receipt');
    pending.options.onTaskProgress(0, { state: 'queued', stalledSince: Date.now() - 60000 });
    const changedDuringWait = tools.get('subagent_wait').execute('w2', { id: first.id, timeout_ms: 40 }, undefined, undefined, ctx);
    setTimeout(() => pending.options.onTaskProgress(0, { state: 'running', stalledSince: undefined, usage: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } }), 10);
    const refreshedWait = await changedDuringWait;
    eq(refreshedWait.details.results[0].state, 'running', 'wait timeout observes checkpoints made during waiting');
    eq(refreshedWait.details.results[0].usage.input, 99, 'wait snapshot usage matches its new observation');
    ok(!render(refreshedWait).join('\n').includes('stalled'), 'wait receipt does not preserve a cleared stall');
    const controller = new AbortController(); controller.abort();
    const aborted = await call({ action: 'wait', id: first.id }, controller.signal);
    ok(render(aborted).join('\n').includes('aborted'), 'wait abort is a receipt and does not cancel child');
    ok(!pending.options.signal.aborted, 'aborting wait leaves child active');
    await settle();
    eq(notices.length, 0, 'TUI completion has no duplicate terminal toast');
    const delivered = await call({ action: 'wait', id: first.id });
    ok(!!delivered.usage, 'first wait attaches native child usage');
    state.runtime.completions.flushNow();
    eq(messages.length, 0, 'wait-before-batch suppresses redundant completion message');
    const again = await call({ action: 'wait', id: first.id });
    ok(!again.usage && render(again).join('\n').includes('Already delivered'), 'second wait has no duplicate usage and shows receipt');
    const second = await launch(); await settle();
    state.runtime.completions.flushNow();
    eq(messages.length, 1, 'completion-before-wait emits one message');
    eqJson(messages[0].options, { deliverAs: 'steer', triggerTurn: true }, 'model notification delivery contract unchanged');
    const completion = renderers.get('subagent-completion')(messages[0].message, { expanded: true }, theme).render(80).join('\n');
    ok(completion.includes('$0.42') && completion.includes('Fixture review'), 'registered completion renderer keeps cost and single task label');
    ok((await call({ action: 'wait', id: second.id })).usage, 'notification does not consume full wait delivery or native usage');
    const completionRenderer = renderers.get('subagent-completion');
    const parallelCompletion = { ...messages[0].message, details: { runs: [{ ...messages[0].message.details.runs[0], tasks: [messages[0].message.details.runs[0].tasks[0], messages[0].message.details.runs[0].tasks[0]] }] } };
    ok(completionRenderer(parallelCompletion, { expanded: false }, theme).render(100).join('\n').includes('$0.84'), 'registered parallel completion retains aggregate known cost');
    ok(completionRenderer(parallelCompletion, { expanded: true }, theme).render(20).join('\n').includes('$0.42'), 'narrow expanded parallel completion recovers per-task cost');
    for (const runs of [[null], [{ tasks: { length: 1 } }]]) {
      const lines = completionRenderer({ content: 'Original completion text', details: { runs } }, { expanded: true }, theme).render(40);
      ok(lines.join('\n').includes('Original completion text'), 'malformed completion closure recovers original text');
    }
    ok(render({ content: [{ type: 'text', text: 'Empty details evidence' }], details: { results: [], presentation: { id: 123, operation: {} } } }, true).join('\n').includes('Empty details evidence'), 'empty-result malformed presentation does not throw');
    const plan = await call({ action: 'plan', task: 'Plan only', description: 'Plan fixture' });
    ok(render(plan).join('\n').includes('no child spawned'), 'execute plan uses explicit non-execution treatment');
    const all = await call({ action: 'status' });
    ok(render(all).join('\n').includes('status (all)'), 'status-all empty-results path preserves its operation');
    const aliasHeader = tools.get('subagent_wait').renderCall({}, theme, { state: {} }).render(40).join('\n');
    ok(aliasHeader.includes('subagent_wait'), 'registered alias handles partial empty arguments');
    const malformed = { content: [{ type: 'text', text: 'Original legacy output' }], details: { mode: 'single', results: [null, { label: 9, finalOutput: {} }] } };
    ok(render(malformed, true).join('\n').includes('Original legacy output'), 'malformed legacy details fall back inside render closure');
    const error = 'Long diagnostic '.repeat(40) + 'TAIL-SENTINEL';
    ok(render({ content: [{ type: 'text', text: error }] }, true, true, 40).join('\n').includes('TAIL-SENTINEL'), 'registered error fallback retains long first line');
    const block = tools.get('subagent').renderResult(delivered, { expanded: false, isPartial: false }, theme, { state: {}, isError: false });
    const reused = tools.get('subagent').renderResult(again, { expanded: false, isPartial: false }, theme, { state: {}, isError: false, lastComponent: block });
    eq(block, reused, 'real renderResult reuses stable component');
    const box = new TUI.Box(1, 0); box.addChild(block);
    for (const width of [20, 40, 80, 120]) ok(box.render(width).every((line) => TUI.visibleWidth(line) <= width), `host padded Box fits width ${width}`);
    // Parallel operation evidence remains separate from child results.
    const parallel = await launch({ task: undefined, tasks: [{ task: 'a', description: 'A' }, { task: 'b', description: 'B' }] });
    await settle('completed', { worktree: { cwd: temp, branch: 'fixture', baseCommit: 'abc', changed: true } });
    const diff = await call({ action: 'diff', id: parallel.id, index: 0 });
    const diffText = render(diff, true).join('\n');
    ok(diffText.includes('evidence-300') && !diffText.includes('Found two issues'), 'parallel expanded diff renders actual operation evidence');
    ok(diffText.includes('more') || diffText.includes('+'), 'long evidence has visible content');
    ok(diffText.includes('full evidence'), 'visual evidence cap has an explicit full-evidence pointer');
    const apply = render(await call({ action: 'apply', id: parallel.id, index: 0 }), true).join('\n');
    ok(apply.includes('Warning: Review staged changes') && apply.includes('uncommitted'), 'apply keeps warning and truthful operation scope');
    const discard = render(await call({ action: 'discard', id: parallel.id, index: 0 })).join('\n');
    ok(discard.includes('Removed worktree'), 'discard uses a dedicated receipt');
    const cancellable = await launch();
    const cancel = render(await call({ action: 'cancel', id: cancellable.id })).join('\n');
    ok(cancel.includes('requested') && !cancel.includes('✓ done'), 'cancel acceptance never claims child stopped');
    await settle('cancelled');
    state.runtime.completions.flushNow();
    // /btw's foreground execution is private even though the answer card shares grammar.
    const beforeMessages = messages.length;
    const btw = commands.get('btw').handler('A private question', ctx);
    for (let i = 0; i < 30 && !state.pending.length; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await settle(); await btw;
    eq(messages.length, beforeMessages, '/btw does not send a model-facing answer');
    const privateEntries = entries.filter((entry) => entry.customType.includes('btw'));
    ok(privateEntries.some((entry) => entry.data.state === 'running') && privateEntries.some((entry) => entry.data.state === 'done'), '/btw still appends private running and answer entries');
    for (const mode of ['rpc', 'tui']) {
      for (const notifications of ['off', 'batched']) {
        await start(mode, { notifications, widget: 'off' });
        await launch(); await settle('failed', { errorMessage: 'fixture failure' });
        eq(notices.length, mode === 'rpc' || notifications === 'off' ? 1 : 0, `${mode}/${notifications}: terminal alert ownership`);
        eq(messages.length, notifications === 'off' ? 0 : 1, `${mode}/${notifications}: model notification path unchanged`);
      }
    }
    await events.get('session_shutdown')({}, ctx);
    ok(!fixture.mounted, 'shutdown clears installed widget');
  } finally {
    await fixture.close();
  }
}
