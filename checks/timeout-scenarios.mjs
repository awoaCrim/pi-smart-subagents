/** Advisory dispatch clocks against real extension/registry/accounting code and
 * synthetic child RPC. No providers, credentials, installs or paid plan calls. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { extensionFixture } from './extension-scenarios.mjs';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate, label) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await sleep(2); }
  throw Error(`Offline boundary did not arrive: ${label}`);
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Offline operation hung')), 6000); })]); }
  finally { clearTimeout(timer); }
}
const cancelledGate = (gate, signal) => new Promise((resolve, reject) => {
  const abort = () => { signal.removeEventListener('abort', abort); reject(Error('Fixture cancelled')); };
  if (signal.aborted) return abort();
  signal.addEventListener('abort', abort, { once: true });
  gate.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
});

export async function timeoutScenarios(options) {
  const { SRC, PI_ROOT, temp, ok, eq, eqJson } = options;
  const require = createRequire(path.join(PI_ROOT, 'package.json'));
  const esbuild = require('esbuild');
  const source = name => path.join(SRC, 'src', name);
  const keepAlive = setInterval(() => {}, 1000);
  try {
  async function bundle(name, entry, extra = {}) {
    const outfile = path.join(temp, `${name}.mjs`);
    await esbuild.build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
      nodePaths: [path.join(PI_ROOT, 'node_modules')], ...extra });
    return import(pathToFileURL(outfile).href);
  }
  const { startInvocationReminder } = await bundle('clock-check', source('notifications.ts'));
  // Test the timer owner directly, including Node's oversized-delay clamp and
  // exact listener cleanup. All hooks are test-local, not production switches.
  {
    const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
    const scheduled = [], cleared = [];
    let now = 0, fired = 0, unrefs = 0;
    globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay, unref() { unrefs++; } }; scheduled.push(timer); return timer; };
    globalThis.clearTimeout = timer => cleared.push(timer);
    try {
      const controller = new AbortController(), done = deferred();
      const target = 2_147_483_647 + 80;
      const dispose = startInvocationReminder(target, controller.signal, done.promise, () => fired++, () => now);
      eq(scheduled[0].delay, 2_147_483_647, 'reminder chunks oversized timer without marking it due');
      now = 2_147_483_647; scheduled[0].callback();
      eq(fired, 0, 'first long timer chunk does not remind early');
      eq(scheduled[1].delay, 80, 'remaining timer uses original absolute target');
      now = target; scheduled[1].callback(); scheduled[1].callback();
      eq(fired, 1, 'timer callback and repeated dispose are one-shot');
      dispose(); dispose();
      eq(unrefs, 2, 'every reminder timer chunk is unrefed');
      const timerCount = scheduled.length;
      startInvocationReminder(now - 1, new AbortController().signal, deferred().promise, () => fired++, () => now);
      eq(fired, 2, 'already-elapsed invocation reminds immediately after registration');
      eq(scheduled.length, timerCount, 'already-elapsed invocation needs no new timer');
      const before = fired, aborted = new AbortController();
      let adds = 0, removes = 0;
      const add = aborted.signal.addEventListener.bind(aborted.signal), remove = aborted.signal.removeEventListener.bind(aborted.signal);
      aborted.signal.addEventListener = (...args) => { adds++; return add(...args); };
      aborted.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
      const settle = deferred();
      startInvocationReminder(now + 10, aborted.signal, settle.promise, () => fired++, () => now);
      const timer = scheduled.at(-1);
      aborted.abort(); settle.resolve(); await Promise.resolve(); timer.callback();
      eq(fired, before, 'abort plus late settlement suppresses reminder');
      eqJson([adds, removes], [1, 1], 'reminder abort listener removed exactly once');
      ok(cleared.includes(timer), 'abort clears owned timer');
      const finish = deferred(), signal = new AbortController();
      startInvocationReminder(now + 10, signal.signal, finish.promise, () => fired++, () => now);
      const finishedTimer = scheduled.at(-1); finish.resolve(); await Promise.resolve(); finishedTimer.callback();
      eq(fired, before, 'dispatch settlement suppresses a pending alarm');
    } finally { globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; }
  }

  const { runLocalPreflights } = await bundle('preflight-clock-check', source('dispatch-preflight.ts'));
  {
    const gate = deferred(), controller = new AbortController();
    let stopped = false;
    const deps = { signal: controller.signal, assertOwner() {}, checkResumeAvailability: () => ({ ok: true }),
      stat: async () => { await gate.promise; return { isDirectory: () => true }; }, isGitRepo: async () => true };
    const task = { task: 'offline', timeoutMs: 5, cwd: temp };
    const pending = runLocalPreflights([task], temp, deps).catch(error => { stopped = true; return error; });
    await sleep(25);
    ok(!stopped, 'real preflight does not invent a hard advisory timeout');
    controller.abort(); const error = await bounded(pending);
    ok(/cancelled/.test(error.message), 'real nonabortable fs preflight is interrupted by cancel');
    gate.resolve(); await sleep(0);
    const hard = await runLocalPreflights([{ ...task, deadline: Date.now() + 5 }], temp, { ...deps, signal: new AbortController().signal,
      stat: () => new Promise(() => {}) }).then(() => undefined, error => error);
    ok(/timeout during local preflight/.test(hard?.message), 'explicit trusted preflight hard deadline remains enforced');
  }

  // Actual setup/finalization algorithm with only the child attempt replaced.
  // This independently proves that omitting an advisory-derived deadline reaches
  // slow worktree setup, not just the running-child timer.
  const setupState = { launches: 0 };
  globalThis.__subagentClockSetup = setupState;
  try {
    const { runTasks } = await bundle('setup-clock-check', source('orchestrator.ts'), { plugins: [{ name: 'offline-child-only', setup(build) {
      build.onResolve({ filter: /runner\.js$/ }, args => path.basename(args.importer) === 'orchestrator.ts' ? { path: 'child', namespace: 'clock-child' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'clock-child' }, () => ({ loader: 'ts', contents: `export class ChildRunner { async run(spec,signal) {
        globalThis.__subagentClockSetup.launches++;
        return {...spec,state:signal?.aborted?'cancelled':'completed',exitCode:0,messages:[],stderr:'',usage:{input:3,output:1,cacheRead:0,cacheWrite:0,cost:0,contextTokens:0,turns:1},liveText:'offline setup result',toolActivity:'none'};
      } }` }));
    } }] });
    const spec = { task: 'Slow setup', timeoutMs: 5, cwd: temp, isolation: 'worktree', model: 'offline/model', routing: { selectedModel: 'offline/model' }, maxRetries: 0 };
    const gate = deferred(); let setupSignal, finalizations = 0;
    const worktrees = { create: async (_cwd, _label, signal) => { setupSignal = signal; await gate.promise; return { cwd: temp, branch: 'offline', baseCommit: 'base' }; },
      finalize: async handle => { finalizations++; return { ...handle, changed: true }; } };
    const setup = runTasks([spec], { worktrees });
    await sleep(25); ok(!setupSignal.aborted && setupState.launches === 0, 'real worktree setup crosses advisory time without abort or replacement');
    gate.resolve(); const result = await setup;
    eq(result.state, 'completed', 'slow setup proceeds to exactly one child attempt');
    eq(setupState.launches, 1, 'setup clock does not add child launches');
    eq(finalizations, 1, 'real setup retains worktree finalization ownership');
    ok(result.results[0].worktree?.changed, 'retained changed worktree survives advisory threshold');
    const cancelled = new AbortController(), lateSetup = deferred();
    const before = setupState.launches;
    const cancellation = runTasks([spec], { signal: cancelled.signal, worktrees: { ...worktrees, create: async () => { await lateSetup.promise; return { cwd: temp, branch: 'cancelled', baseCommit: 'base' }; } } });
    cancelled.abort(); lateSetup.resolve();
    eq((await cancellation).state, 'cancelled', 'real nonabortable setup rechecks cancel after await');
    eq(setupState.launches, before, 'cancelled late worktree setup never launches a child');
  } finally { delete globalThis.__subagentClockSetup; }

  const fixture = await extensionFixture({ ...options, toolMode: 'full' });
  const { state, start, call, settle, messages, entries, notices, tools, commands, ctx, events } = fixture;
  let receiptId = 0;
  const receipt = (router, purpose = 'dispatch', outcome = 'success') => router.onReceipt({ requestId: `offline-selector-${++receiptId}`,
    purpose, selectorModel: 'offline-selector', outcome, code: outcome === 'timeout' ? 'timeout' : undefined,
    durationMs: 20, inputTokens: 7, outputTokens: 3, usageStatus: 'reported', currency: 'unknown' });
  const lookup = id => state.runtime.registry.lookup(id, state.runtime.key).run;
  const reminders = () => messages.filter(item => item.message.customType === 'subagent-reminder');
  const resetHooks = () => { for (const key of ['configHook', 'preflightHook', 'routeHook', 'childHook', 'appendHook']) delete state[key]; };
  try {
    for (const phase of ['preflight', 'routing']) {
      resetHooks(); await start('tui', { notifications: 'off' });
      const gate = deferred(), initiating = new AbortController();
      let entered = false, boundarySignal;
      state[phase === 'preflight' ? 'preflightHook' : 'routeHook'] = async (...args) => {
        entered = true; boundarySignal = phase === 'preflight' ? args[2].signal : args[3].signal;
        await cancelledGate(gate, boundarySignal);
        if (phase === 'routing') receipt(args[2]);
      };
      const beforeStarts = state.registryStarts, beforeChildren = state.children;
      const pending = call({ task: `Slow ${phase}`, timeout_ms: 35 }, initiating.signal);
      await until(() => entered, phase);
      const result = await bounded(pending), id = result.details.id;
      ok(id.length > 20 && result.content[0].text.includes(id), `${phase} handoff returns full registered id`);
      eq(result.details.presentation.operation, 'Elapsed handoff', `${phase} returns an advisory receipt`);
      eq(result.details.state, 'queued', `${phase} handoff observes prelaunch queued state`);
      ok(!result.usage && !lookup(id).delivered, `${phase} handoff consumes neither result nor native usage`);
      eq(state.registryStarts - beforeStarts, 1, `${phase} has one registry entry`);
      eq(state.children - beforeChildren, 0, `${phase} alarm starts no child`);
      eq(state.runtime.pendingRoutes.size, 1, `${phase} detached pipeline retains pending route scope`);
      initiating.abort(); ok(!boundarySignal.aborted, `${phase} detached route ignores old initiating abort`);
      gate.resolve(); await until(() => state.pending.length, 'child after handoff');
      const pendingChild = state.pending[0];
      ok(!pendingChild.options.signal.aborted, `${phase} same child survives old caller signal`);
      ok(pendingChild.specs.every(spec => spec.deadline === undefined), `${phase} extension sends no advisory-derived hard deadline`);
      const timed = await tools.get('subagent_wait').execute('bounded', { id, timeout_ms: 4 }, undefined, undefined, ctx);
      ok(timed.content[0].text.includes('NOT cancelled') && !lookup(id).delivered, `${phase} later wait limit is nonconsuming`);
      const abortWait = new AbortController(); abortWait.abort();
      await call({ action: 'wait', id }, abortWait.signal);
      ok(!pendingChild.options.signal.aborted && !lookup(id).delivered, `${phase} wait abort leaves detached run alive`);
      state.runtime.liveRunners.set(id, new Map([[0, { steer: () => true }]]));
      ok((await call({ action: 'steer', id, message: 'Finish safely' })).content[0].text.includes('queued'), `${phase} same full id supports steer`);
      await settle(); const delivered = await call({ action: 'wait', id });
      eq(delivered.usage.input, phase === 'routing' ? 127 : 120, `${phase} later wait delivers retained child/late selector usage`);
      ok(!(await call({ action: 'wait', id })).usage, `${phase} repeat collection has no native usage`);
      eq(reminders().length, 0, `${phase} tool reminder is not duplicated as a parent message`);
    }

    resetHooks(); await start();
    state.configHook = () => sleep(45);
    const delayedConfig = await bounded(call({ task: 'Preparation already overdue', timeout_ms: 15 }));
    eq(delayedConfig.details.presentation.operation, 'Elapsed handoff', 'invocation clock includes config/preparation before registration');
    delete state.configHook; await until(() => state.pending.length, 'already-overdue detached launch');
    await settle(); await call({ action: 'wait', id: delayedConfig.details.id });

    resetHooks(); await start();
    const configGate = deferred(); let readingConfig = false;
    state.configHook = async () => { readingConfig = true; await configGate.promise; };
    const configCounts = { starts: state.registryStarts, routes: state.routes, children: state.children, tools: state.toolCatalogReads, agents: state.catalogReads };
    const staleConfig = call({ task: 'Old branch config preparation', timeout_ms: 20 }).then(() => undefined, error => error);
    await until(() => readingConfig, 'config read before registration');
    await events.get('session_before_tree')({}, ctx); await events.get('session_tree')({}, ctx);
    configGate.resolve(); const staleConfigError = await bounded(staleConfig);
    ok(/previous session\/branch/.test(staleConfigError?.message), 'config-delayed invocation rejects after branch generation changes');
    eqJson({ starts: state.registryStarts, routes: state.routes, children: state.children, tools: state.toolCatalogReads, agents: state.catalogReads }, configCounts,
      'old config invocation cannot register, read catalogs, select or launch on new branch');

    // Post-handoff failures must ignore an obsolete initiating signal, retain
    // selector evidence and settle the original run instead of throwing unhandled.
    resetHooks(); await start();
    const failureGate = deferred(), oldCaller = new AbortController();
    state.routeHook = async (_tasks, _catalog, router) => { await failureGate.promise; receipt(router); throw Error('Offline route failed'); };
    const failedReceipt = await bounded(call({ task: 'Late failure', timeout_ms: 20 }, oldCaller.signal));
    const failedId = failedReceipt.details.id; oldCaller.abort(); failureGate.resolve();
    await until(() => !('controller' in lookup(failedId)), 'retained routing failure');
    eq(lookup(failedId).state, 'failed', 'detached prelaunch failure does not use stale initiating abort classification');
    eq(state.runtime.pendingRoutes.size, 0, 'detached prelaunch failure cleans pending route scope');
    ok(entries.some(e => e.customType === 'subagent-routing-v1' && e.data.runId === failedId), 'late failed selection evidence stays linked to full id');
    const failedWait = await call({ action: 'wait', id: failedId }).then(() => undefined, error => error);
    ok(/Offline route failed/.test(failedWait?.message), 'late prelaunch failure is collectable through normal thrown-failure delivery');
    ok(!(await call({ action: 'wait', id: failedId })).usage, 'failed result delivery also remains once-only');

    for (const handoffFirst of [false, true]) {
      resetHooks(); await start(); const gate = deferred(), caller = new AbortController();
      state.preflightHook = (_tasks, _cwd, deps) => cancelledGate(gate, deps.signal);
      const before = state.children;
      const operation = call({ task: 'Cancel delayed preflight', timeout_ms: handoffFirst ? 15 : 250 }, caller.signal);
      if (handoffFirst) { const result = await bounded(operation); await call({ action: 'cancel', id: result.details.id }); }
      else { await until(() => state.runtime.pendingRoutes.size, 'registered foreground'); caller.abort(); await bounded(operation.catch(() => undefined)); }
      await until(() => state.runtime.pendingRoutes.size === 0, 'cancelled prelaunch scope cleanup');
      gate.resolve(); await sleep(5);
      eq(state.children, before, `cancel ${handoffFirst ? 'after' : 'before'} handoff prevents late launch`);
      eq(state.runtime.registry.getSnapshots(state.runtime.key).at(-1).state, 'cancelled', 'prelaunch cancellation terminalizes same run');
    }

    resetHooks(); await start('tui', { notifications: 'off' });
    state.routeHook = (_tasks, _catalog, router) => receipt(router);
    const asyncCaller = new AbortController();
    const asyncReceipt = await call({ task: 'Background reminder', timeout_ms: 40, async: true }, asyncCaller.signal);
    ok(asyncReceipt.usage?.input === 7, 'ordinary async startup retains selector native attachment');
    asyncCaller.abort(); ok(!state.pending[0].options.signal.aborted, 'explicit async startup uses the same caller detach operation');
    await until(() => reminders().length, 'background one-shot reminder'); await sleep(55);
    eq(reminders().length, 1, 'completion-off background still receives exactly one advisory reminder');
    eqJson(reminders()[0].options, { deliverAs: 'steer', triggerTurn: true }, 'live reminder steers parent before next LLM request');
    ok(reminders()[0].message.content.includes(asyncReceipt.details.id), 'parent reminder includes full id');
    ok(!lookup(asyncReceipt.details.id).delivered, 'parent reminder never claims final delivery');
    await settle(); const asyncFinal = await call({ action: 'wait', id: asyncReceipt.details.id });
    eq(asyncFinal.usage.input, 120, 'selector delivered at async startup is not repeated at terminal wait');

    // The alarm occurs during bounded retry of the native-delivery append.
    // Locking startup first must preserve that attachment, not return handoff.
    resetHooks(); await start('tui', { notifications: 'off' });
    state.routeHook = (_tasks, _catalog, router) => receipt(router);
    let claimAttempts = 0;
    state.appendHook = (type, data) => { if (type === 'subagent-routing-v1' && data.kind === 'native-delivery' && ++claimAttempts < 3) throw Error('Offline persistence busy'); };
    const committed = await call({ task: 'Usage commit alarm race', timeout_ms: 15, async: true });
    eq(committed.details.presentation.operation, 'Started in background', 'startup selected before alarm cannot be replaced during usage commit');
    eq(committed.usage.input, 7, 'startup commit racing alarm retains selector native attachment');
    eq(reminders().length, 1, 'alarm delayed by selected startup commit uses one parent reminder');
    await settle(); eq((await call({ action: 'wait', id: committed.details.id })).usage.input, 120, 'racing startup/wait still account once');

    resetHooks(); await start('tui', { notifications: 'off' });
    state.routeHook = (_tasks, _catalog, router) => receipt(router);
    let settledClaimAttempts = 0;
    state.appendHook = (type, data) => {
      if (type === 'subagent-routing-v1' && data.kind === 'native-delivery' && ++settledClaimAttempts < 3) throw Error('Offline persistence busy');
    };
    const childFinished = deferred();
    state.childHook = () => setTimeout(() => { settle().then(childFinished.resolve); }, 0);
    const claimsBeforeStartup = state.deliveryClaims;
    const settledStartup = await call({ task: 'Child settles during startup usage commit', timeout_ms: 15, async: true });
    await childFinished.promise;
    eq(settledStartup.details.state, 'completed', 'startup accounting receipt refreshes a child that settled during its commit');
    eq(settledStartup.details.presentation.operation, 'Background run settled', 'settled startup never claims a still-running child');
    eq(settledStartup.usage.input, 7, 'settled startup retains its already-selected selector attachment');
    eq(state.deliveryClaims, claimsBeforeStartup, 'settled startup receipt does not consume the final result');
    eq(reminders().length, 0, 'settlement during startup commit suppresses obsolete overdue reminder');
    eq((await call({ action: 'wait', id: settledStartup.details.id })).usage.input, 120, 'wait delivers execution once after a settled startup receipt');

    // A wait may collect the now-terminal run while async-start is retrying
    // its native batch append. Both receipts must share the same commit winner.
    resetHooks(); await start('tui', { notifications: 'off' });
    state.routeHook = (_tasks, _catalog, router) => receipt(router);
    let concurrentClaimAttempts = 0;
    state.appendHook = (type, data) => {
      if (type === 'subagent-routing-v1' && data.kind === 'native-delivery' && ++concurrentClaimAttempts < 3) throw Error('Offline persistence busy');
    };
    const concurrentStartup = call({ task: 'Concurrent wait during startup usage retry', timeout_ms: 250, async: true });
    await until(() => concurrentClaimAttempts > 0 && state.pending.length, 'startup native commit retry');
    const concurrentId = state.runtime.registry.getLiveRuns(state.runtime.key)[0].id;
    await settle();
    const concurrentWait = await call({ action: 'wait', id: concurrentId });
    const startupAfterWait = await bounded(concurrentStartup);
    eq(concurrentWait.usage.input, 127, 'concurrent terminal wait claims execution and linked selector tokens');
    eq((startupAfterWait.usage?.input ?? 0) + concurrentWait.usage.input, 127, 'startup retry cannot repeat selector tokens already claimed by wait');
    eq(entries.filter(e => e.data?.kind === 'native-delivery').length, 0, 'losing startup batch persists no second native claim');
    ok(!(await call({ action: 'wait', id: concurrentId })).usage, 'concurrent startup/wait retains once-only terminal collection');

    resetHooks(); await start('tui', { notifications: 'off' });
    state.routeHook = (_tasks, _catalog, router) => receipt(router);
    let startupWinnerAttempts = 0, competingWait;
    state.appendHook = (type, data) => {
      if (type !== 'subagent-routing-v1' || data.kind !== 'native-delivery') return;
      if (++startupWinnerAttempts === 1) throw Error('Offline persistence busy');
      // Begin wait in the startup append turn; its persistence await must let
      // this winning batch commit without repeating selector usage.
      const id = state.runtime.registry.getSnapshots(state.runtime.key).at(-1).id;
      competingWait = call({ action: 'wait', id });
    };
    const startupWinner = call({ task: 'Startup commit wins concurrent wait', timeout_ms: 250, async: true });
    await until(() => startupWinnerAttempts > 0 && state.pending.length, 'startup winner retry');
    await settle();
    const startupWon = await bounded(startupWinner), waitAfterStartup = await bounded(competingWait);
    eq(startupWon.usage.input, 7, 'winning startup batch retains its selector attachment');
    eq(waitAfterStartup.usage.input, 120, 'concurrent wait excludes selector tokens committed by startup');
    eq(entries.filter(e => e.data?.kind === 'native-delivery').length, 1, 'startup winner persists one atomic batch');
    ok(!(await call({ action: 'wait', id: startupWon.details.id })).usage, 'startup-first concurrent wait consumes terminal output once');

    resetHooks(); await start('tui', { notifications: 'off' });
    const asyncRouteGate = deferred();
    state.routeHook = async (_tasks, _catalog, router) => { await asyncRouteGate.promise; receipt(router); };
    const earlyAsync = await bounded(call({ task: 'Async still selecting', timeout_ms: 15, async: true }));
    eq(earlyAsync.details.presentation.operation, 'Elapsed handoff', 'async startup still selecting can hand off before launch');
    ok(!earlyAsync.usage, 'early async handoff claims no unfinished selector usage');
    asyncRouteGate.resolve(); await until(() => state.pending.length, 'async detached selection launch');
    eq(entries.filter(e => e.data?.kind === 'native-delivery').length, 0, 'detached async startup never silently consumes selector native attachment');
    await settle(); eq((await call({ action: 'wait', id: earlyAsync.details.id })).usage.input, 127, 'wait collects late detached async selector tokens once');

    resetHooks(); await start();
    const beforeComplete = call({ task: 'Complete before alarm', timeout_ms: 120 });
    await until(() => state.pending.length, 'quick foreground child'); await settle();
    const complete = await bounded(beforeComplete); await sleep(140);
    eq(complete.details.state, 'completed', 'completion before threshold keeps normal foreground delivery');
    eq(reminders().length, 0, 'completed dispatch suppresses alarm');
    ok(!state.runtime.asyncRuns.has(complete.details.id), 'completion does not acquire background ownership');

    // Trigger the real owned due callback in the same event turn as completion
    // or cancel, before Promise.race continuations run. Only this invocation's
    // ~400ms timer is intercepted; unrelated cleanup/update timers stay real.
    for (const race of ['completion', 'cancel-before-due', 'due-before-cancel']) {
      resetHooks(); await start();
      const oldSet = globalThis.setTimeout, oldNow = Date.now;
      let now = oldNow(), due;
      const held = [];
      Date.now = () => now;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay >= 350 && delay <= 400) {
          due = callback;
          const handle = oldSet(() => {}, 100000); held.push(handle); return handle;
        }
        return oldSet(callback, delay, ...args);
      };
      try {
        const operation = call({ task: 'Same-turn alarm race', timeout_ms: 400 });
        await until(() => state.pending.length && due, race);
        const live = state.runtime.registry.getLiveRuns(state.runtime.key)[0];
        now += 400;
        let settlement;
        if (race === 'completion') { settlement = settle(); due(); }
        else {
          if (race === 'due-before-cancel') due();
          live.controller.abort();
          if (race === 'cancel-before-due') due();
          settlement = settle('cancelled');
        }
        const result = await bounded(operation); await settlement;
        eq(result.details.state, race === 'completion' ? 'completed' : 'cancelled', `${race} observes terminal state instead of a false live receipt`);
        ok(result.details.presentation?.operation !== 'Elapsed handoff', `${race} never claims still-running handoff`);
        eq(reminders().length, 0, `${race} suppresses duplicate or false parent reminder`);
      } finally { Date.now = oldNow; globalThis.setTimeout = oldSet; held.forEach(clearTimeout); }
    }

    resetHooks(); await start();
    const queuedOperation = call({ task: 'Child still awaiting queue or setup', timeout_ms: 25 });
    await until(() => state.pending.length, 'queued execution boundary');
    state.pending[0].options.onTaskProgress(0, { state: 'queued', liveText: undefined });
    state.pending[0].options.onTaskProgress(0, { worktree: { cwd: temp, branch: 'queue-fixture', baseCommit: 'base', changed: false } });
    const queuedReceipt = await bounded(queuedOperation);
    eq(queuedReceipt.details.state, 'queued', 'all-queued child/setup checkpoints retain truthful queued handoff state');
    eq(queuedReceipt.details.results[0].state, 'queued', 'queue handoff keeps per-task evidence queued');
    await settle(); await call({ action: 'wait', id: queuedReceipt.details.id });

    resetHooks(); await start();
    const parallel = call({ tasks: [{ task: 'Finished short worker', timeout_ms: 25 }, { task: 'Pending longer sibling', timeout_ms: 200 }] });
    await until(() => state.pending.length, 'parallel workers');
    state.pending[0].options.onTaskProgress(0, { state: 'completed', finalOutput: 'worker one done' });
    const group = await bounded(parallel);
    eq(group.details.state, 'running', 'one completed worker cannot label live parallel group done');
    eq(group.details.results[0].state, 'completed', 'parallel receipt retains individual worker completion');
    eq(group.details.presentation.operation, 'Elapsed handoff', 'parallel uses shortest resolved item threshold');
    await settle(); await call({ action: 'wait', id: group.details.id });
    eq(reminders().length, 0, 'parallel group reminder uses tool receipt only');

    resetHooks(); await start();
    const synthesis = call({ tasks: [{ task: 'worker A', timeout_ms: 40 }, { task: 'worker B', timeout_ms: 200 }], synthesis: 'Combine results' });
    await until(() => state.pending.length, 'synthesis workers');
    await settle(); await until(() => state.pending.length, 'optional synthesis child');
    const synthesized = await bounded(synthesis);
    eq(synthesized.details.state, 'running', 'synthesis retains live aggregate state after completed workers');
    eq(synthesized.details.presentation.operation, 'Elapsed handoff', 'unchanged invocation clock includes optional synthesis');
    ok(synthesized.content[0].text.includes('optional synthesis is still pending'), 'synthesis reminder identifies live fan-in instead of calling finished workers overdue');
    ok(synthesized.details.results.every(result => result.state === 'completed'), 'synthesis receipt preserves workers actual settled states');
    ok(state.pending[0].specs[0].deadline === undefined, 'synthesis has no advisory-derived hard deadline');
    await settle(); const synthesizedFinal = await call({ action: 'wait', id: synthesized.details.id });
    eq(synthesizedFinal.details.results.length, 3, 'later wait retains synthesis plus worker outputs');
    eq(synthesizedFinal.usage.input, 360, 'synthesis execution usage survives handoff once');

    resetHooks(); await start('tui', { defaultTimeoutMs: 20 });
    const privateCall = commands.get('btw').handler('A private overdue question', ctx);
    await until(() => state.pending.length, 'private child'); await sleep(40);
    eq(messages.length, 0, '/btw overdue reminder never enters parent message queue');
    eq(entries.filter(e => e.customType === 'subagent-btw').at(-1)?.data.state, 'running', '/btw overdue notice is not a completed answer');
    ok(notices.some(n => n[0].includes('privately awaiting')), '/btw overdue task produces human-only notice');
    eq(state.runtime.asyncRuns.size, 0, '/btw never acquires parent completion ownership');
    await settle(); await privateCall;
    eq(messages.length, 0, '/btw final answer also stays private');
    eq(entries.filter(e => e.customType === 'subagent-btw').at(-1)?.data.state, 'done', '/btw privately awaits actual final answer');

    for (const event of ['session_before_tree', 'session_shutdown']) {
      resetHooks(); await start(); const gate = deferred();
      state.routeHook = (_tasks, _catalog, _router, deps) => cancelledGate(gate, deps.signal);
      const before = state.children;
      await bounded(call({ task: 'Detached route lifecycle', timeout_ms: 15 }));
      await bounded(events.get(event)({}, ctx)); gate.resolve(); await sleep(25);
      eq(state.children, before, `${event} prevents detached late child launch`);
      eq(state.runtime.pendingRoutes.size, 0, `${event} retains and then cleans pending routing lifetime`);
      eq(reminders().length, 0, `${event} emits no stale parent reminder`);
    }
  } finally { resetHooks(); await fixture.close(); }

  await runnerClocks({ ...options, bundle });
  } finally { clearInterval(keepAlive); }
}

async function runnerClocks({ SRC, temp, ok, eq, bundle }) {
  // The actual runner and Pi JSONL parser communicate with a tiny node child.
  // That child never imports Pi or invokes a provider; it only speaks RPC.
  const entry = path.join(temp, 'runner-clock-entry.ts');
  // Use the supplied source root; no file-URL pathname assumptions on Windows.
  const sourceRoot = SRC;
  fs.writeFileSync(entry, `export { runSubagent } from ${JSON.stringify(path.join(sourceRoot,'src/runner.ts'))};\nexport { ProtocolParser } from ${JSON.stringify(path.join(sourceRoot,'src/protocol.ts'))};\nexport { Semaphore } from ${JSON.stringify(path.join(sourceRoot,'src/semaphore.ts'))};\nexport * from ${JSON.stringify(path.join(sourceRoot,'src/startup-check.ts'))};\n`);
  fs.writeFileSync(path.join(temp, 'child-preflight.ts'), '// synthetic provenance target\n');
  const R = await bundle('runner-clock-check', entry);
  const script = path.join(temp, 'synthetic-clock-child.mjs');
  fs.writeFileSync(script, `import * as fs from 'node:fs'; import * as readline from 'node:readline';
const cfg=JSON.parse(process.argv[2]); const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
send({type:'session',id:'synthetic-session'});
const rl=readline.createInterface({input:process.stdin});
rl.on('close',()=>process.exit(0));
rl.on('line',line=>{ const c=JSON.parse(line); fs.appendFileSync(cfg.log,JSON.stringify(c)+'\\n');
 if(c.type==='get_commands'){ if(cfg.silentStartup)return; setTimeout(()=>send({type:'response',command:'get_commands',id:c.id,success:true,data:{commands:[{name:cfg.command,source:'extension',sourceInfo:{path:cfg.commandPath}}]}}),cfg.startupDelay); }
 if(c.type==='prompt'&&c.id==='pi-subagent-preflight-prompt'){send({type:'response',command:'prompt',id:c.id,success:true});send({type:'message_end',message:{role:'custom',customType:'pi-subagent-preflight-ack',content:JSON.stringify({schema:'pi-subagent-preflight-ack/1',nonce:cfg.nonce,model:{provider:'offline',id:cfg.wrongModel?'wrong':'model'},tools:[],registeredNativeTools:[],nestedToolsWithSource:[],host:{version:'1.1.0'}})}});}
 else if(c.type==='prompt'){ if(cfg.stall)return; setTimeout(()=>{send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'synthetic result'}],api:'offline',provider:'offline',model:'model',usage:{input:9,output:4,cacheRead:0,cacheWrite:0,cost:{total:1}},stopReason:'stop',timestamp:1}});send({type:'agent_end',willRetry:false});send({type:'agent_settled'});},cfg.executionDelay); }
});`);
  let number = 0;
  const readLog = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function run({ routed = true, hard = false, sdkTimeout = 10, semaphore, ...cfg } = {}) {
    const nonce = 'offline_nonce_123', log = path.join(temp, `rpc-clock-${number++}.jsonl`), manifest = path.join(temp, `manifest-${number}.json`);
    fs.writeFileSync(manifest, JSON.stringify({ schema: R.PREFLIGHT_MANIFEST_SCHEMA, nonce, model: 'offline/model', tools: [], nativeTools: [], nestedTools: [] }));
    const child = { log, nonce, command: R.preflightCommandBase(nonce), commandPath: R.ownPreflightExtensionPath(), startupDelay: 35, executionDelay: 40, ...cfg };
    const backend = { name: 'synthetic-pi-clock', capabilities: { steer: true, gracefulWrapUp: true, costReporting: true, resume: true, fork: true, toolRestriction: true, thinking: true, outputSchema: true },
      createParser: () => new R.ProtocolParser(),
      buildInvocation: async () => ({ command: process.execPath, args: [script, JSON.stringify(child)], env: { [R.PREFLIGHT_MANIFEST_ENV]: manifest } }),
      steerCommand: message => ({ type: 'steer', message }), stateCommand: () => ({ type: 'get_state' }), stopCommand: () => ({ type: 'abort' }) };
    const spec = { task: 'synthetic task', label: 'clock', timeoutMs: sdkTimeout, cwd: temp, model: 'offline/model', tools: [],
      ...(routed ? { routing: { selectedModel: 'offline/model' } } : {}), ...(hard ? { deadline: Date.now() + 15 } : {}),
      maxTurns: cfg.maxTurns, maxCost: cfg.maxCost };
    let pid;
    const result = await bounded(R.runSubagent(spec, { backend, semaphore, sessionDir: temp, killGraceMs: 100, startupTimeoutMs: cfg.startupTimeoutMs ?? 1200,
      onCheckpoint: update => { if (update.process) pid = update.process.pid; },
      stallAfterMs: cfg.stall ? 15 : 0, stallKillAfterMs: cfg.stall ? 15 : 0, graceTurns: cfg.graceTurns ?? 0 }));
    // Windows taskkill is asynchronous. Observe actual process death before the
    // harness removes its temporary cwd; never kill an unrelated/recycled pid.
    if (pid) await bounded((async () => {
      for (;;) { try { process.kill(pid, 0); } catch { break; } await sleep(20); }
    })());
    return { result, commands: readLog(log) };
  }
  const semaphore = new R.Semaphore(1, 4); await semaphore.acquire();
  const queued = run({ semaphore }); setTimeout(() => semaphore.release(), 35);
  const advisory = await queued;
  eq(advisory.result.state, 'completed', 'actual routed child crosses queue/startup/execution advisory threshold without stop');
  ok(advisory.commands.some(c => c.type === 'prompt' && c.message === 'synthetic task'), 'actual runner sends real task only after delayed verified startup');
  eq(advisory.result.usage.input, 9, 'actual RPC result retains known usage beyond advisory threshold');
  const sdk = await run({ routed: false, sdkTimeout: 15 });
  eq(sdk.result.state, 'timeout', 'trusted unranked SDK still has hard elapsed timeout');
  const hardQueue = new R.Semaphore(1, 4); await hardQueue.acquire();
  const hard = await run({ hard: true, semaphore: hardQueue }); hardQueue.release();
  eq(hard.result.state, 'timeout', 'explicit routed hard deadline still stops queue wait');
  eq(hard.result.timeoutPhase, 'queued', 'explicit hard deadline retains queue phase evidence');
  const startup = await run({ silentStartup: true, startupTimeoutMs: 150 });
  eq(startup.result.stopReason, 'capability_mismatch', 'independent startup timeout still fails closed');
  ok(!startup.commands.some(c => c.type === 'prompt' && c.message === 'synthetic task'), 'failed startup never sends task prompt');
  ok(startup.result.errorMessage?.includes('150 ms'), 'startup fault reports its independent budget, not advisory threshold');
  const mismatch = await run({ wrongModel: true });
  eq(mismatch.result.stopReason, 'capability_mismatch', 'startup model mismatch remains fail-closed');
  const stalled = await run({ stall: true });
  eq(stalled.result.stopReason, 'stalled', 'independent protocol-silence watchdog still stops unhealthy child');
  ok(stalled.commands.some(c => c.type === 'get_state'), 'stall path still probes child liveness');
  const turnBudget = await run({ maxTurns: 0 });
  eq(turnBudget.result.stopReason, 'max_turns', 'actual advisory runner retains turn budget stop');
  const costBudget = await run({ maxCost: 0 });
  eq(costBudget.result.stopReason, 'max_cost', 'actual advisory runner retains cost budget stop');
  const grace = await run({ maxCost: 0, graceTurns: 1 });
  ok(grace.result.state === 'partial' && grace.result.wrappedUp, 'actual advisory runner preserves a clean wrap-up within budget grace');
  ok(grace.commands.some(command => command.type === 'steer'), 'budget grace still steers a wrap-up instead of silently extending authorization');
}
