#!/usr/bin/env node
/** Provider-free registered two-tool payload measurement. Uses only installed peers.
 * --revision freezes production sources and skill via git show; never reads private
 * settings or a live agent catalog. Stable sorted JSON measures UTF-8 bytes, not tokens.
 * node checks/surface-fixture.mjs --revision 414162a --output <baseline.json>
 * node checks/surface-fixture.mjs --output <after.json>
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const fixtureConfig = { jevRouting: { apiKey: 'offline-fixture-not-a-secret', selectorModel: 'fixture-selector', timeoutMs: 15000,
  models: [{ model: 'offline/model', description: 'Synthetic provider-free candidate', thinking: 'high' }] } };
export const fixtureAgents = [
  { name: 'fixture-review', description: 'Review synthetic source', profile: 'review', systemPrompt: 'Synthetic review persona' },
  { name: 'fixture-build', description: 'Implement synthetic work', profile: 'general', isolation: 'worktree', systemPrompt: 'Synthetic build persona' },
];
export const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(stable(value)), 'utf8');
export function installedPi(explicit) {
  if (explicit || process.env.PI_GLOBAL_DIR) return path.resolve(explicit || process.env.PI_GLOBAL_DIR);
  try { return path.dirname(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent/package.json')); } catch {}
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g'], { encoding: 'utf8' })
    : spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (result.status) throw Error('Installed Pi unavailable; use --pi-root. No install attempted.');
  return path.join(result.stdout.trim(), '@earendil-works/pi-coding-agent');
}
export async function registrationFixture({ SRC, PI_ROOT, temp }) {
  const require = createRequire(path.join(PI_ROOT, 'package.json'));
  const source = (name) => path.join(SRC, 'src', name);
  const outfile = path.join(temp, 'surface-registration.mjs');
  await require('esbuild').build({ entryPoints: [source('extension.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    nodePaths: [path.join(PI_ROOT, 'node_modules')],
    alias: { '@earendil-works/pi-tui': path.dirname(path.dirname(require.resolve('@earendil-works/pi-tui'))) },
    plugins: [{ name: 'provider-free-registration', setup(build) {
      build.onResolve({ filter: /@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'host', namespace: 'fixture' }));
      build.onResolve({ filter: /\.js$/ }, (args) => {
        if (path.basename(args.importer) !== 'extension.ts') return;
        if (['config.js','agents.js','launch.js'].includes(path.basename(args.path))) return { path: path.basename(args.path), namespace: 'fixture' };
      });
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ loader: 'ts', resolveDir: path.join(SRC,'src'), contents: {
        host: `export const keyHint=()=>'';`,
        'config.js': `export * from ${JSON.stringify(source('config.ts'))}; export const readConfigFile=async()=>globalThis.__surfaceFixture.config;`,
        'agents.js': `export { describeCatalog } from ${JSON.stringify(source('agents.ts'))}; export const discoverAgents=()=>new Map(globalThis.__surfaceFixture.agents.map(a=>[a.name,a]));`,
        'launch.js': `export const createGetPiCommand=()=>()=>{throw Error('Process launch forbidden')}; export const getLaunchResolution=()=>({});`,
      }[args.path] }));
    }}],
  });
  return (await import(pathToFileURL(outfile).href)).default;
}
async function main() {
  const args = process.argv.slice(2), arg = (name) => args[args.indexOf(name)+1];
  const value = (name) => args.includes(name) ? arg(name) : undefined;
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const revision = value('--revision');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-surface-'));
  const git = (...argv) => { const r = spawnSync('git', argv, { cwd: repo, maxBuffer: 20*1024*1024 }); if (r.status) throw Error(r.stderr.toString()); return r.stdout; };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Network forbidden in surface fixture'); };
  try {
    let SRC = repo;
    if (revision) {
      SRC = path.join(temp,'frozen');
      for (const file of git('ls-tree','-r','--name-only',revision,'src').toString().trim().split('\n')) {
        fs.mkdirSync(path.dirname(path.join(SRC,file)),{recursive:true}); fs.writeFileSync(path.join(SRC,file),git('show',`${revision}:${file}`));
      }
    }
    const register = await registrationFixture({SRC,PI_ROOT:installedPi(value('--pi-root')),temp});
    const modes = revision ? ['baseline'] : ['compact','full'];
    const measurements = [];
    for (const mode of modes) for (const catalog of ['empty','synthetic']) {
      globalThis.__surfaceFixture = { config:{...fixtureConfig,...(mode==='baseline'?{}:{toolMode:mode})}, agents:catalog==='empty'?[]:fixtureAgents };
      const tools=[], events=new Map();
      await register({registerTool:t=>tools.push(t),on:(n,h)=>events.set(n,h),registerCommand(){},registerMessageRenderer(){},registerEntryRenderer(){}});
      const definitions = tools.map(tool => Object.fromEntries(['name','description','parameters','promptGuidelines','promptSnippet'].filter(k=>tool[k]!==undefined).map(k=>[k,tool[k]])));
      const routingText = (await events.get('before_agent_start')({systemPrompt:''})).systemPrompt.replace(/^\n\n/,'');
      const main=definitions.find(t=>t.name==='subagent');
      measurements.push({mode,catalog,rootProperties:Object.keys(main.parameters.properties).length,itemProperties:Object.keys(main.parameters.properties.tasks.items.properties).length,
        actions:main.parameters.properties.action.anyOf.map(a=>a.const),toolsBytes:serializedBytes(definitions),routingBytes:Buffer.byteLength(routingText),
        payloadBytes:serializedBytes({tools:definitions,routingText}),definitions:stable(definitions),routingText});
    }
    const skill = revision ? git('show',`${revision}:skills/subagent/SKILL.md`) : fs.readFileSync(path.join(repo,'skills/subagent/SKILL.md'));
    const report={schema:'pi-subagent-surface-measurement/1',revision:revision?git('rev-parse',revision).toString().trim():'working-tree',fixture:stable({config:fixtureConfig,agents:fixtureAgents}),
      skill:{bytes:skill.length,physicalLines:skill.toString().split('\n').length-(skill.toString().endsWith('\n')?1:0)},measurements};
    const baselineFile=value('--baseline');
    if (baselineFile) {
      if (revision) throw Error('--baseline compares the working tree, not another baseline.');
      const baseline=JSON.parse(fs.readFileSync(baselineFile,'utf8'));
      if(JSON.stringify(stable(baseline.fixture))!==JSON.stringify(stable(report.fixture))) throw Error('Baseline fixture differs; comparison would be misleading.');
      report.comparison={baselineRevision:baseline.revision,skillReductionPercent:100*(1-report.skill.bytes/baseline.skill.bytes),
        skillPass:report.skill.bytes<=baseline.skill.bytes/2,
        measurements:measurements.map(m=>{const old=baseline.measurements.find(b=>b.catalog===m.catalog);
          return {mode:m.mode,catalog:m.catalog,baselineBytes:old.payloadBytes,payloadBytes:m.payloadBytes,reductionPercent:100*(1-m.payloadBytes/old.payloadBytes),
            pass:m.payloadBytes<=old.payloadBytes*(m.mode==='compact'?.6:1),
            catalogAddedBytes:m.catalog==='synthetic'?m.payloadBytes-measurements.find(a=>a.mode===m.mode&&a.catalog==='empty').payloadBytes:0,
            baselineCatalogAddedBytes:m.catalog==='synthetic'?old.payloadBytes-baseline.measurements.find(b=>b.catalog==='empty').payloadBytes:0};}),
      };
      if(!report.comparison.skillPass || report.comparison.measurements.some(m=>!m.pass)) process.exitCode=1;
    }
    const output=value('--output'); if(output) {fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
    console.log(JSON.stringify({...report,measurements:measurements.map(({definitions,routingText,...m})=>m)},null,2));
  } finally {globalThis.fetch=oldFetch;delete globalThis.__surfaceFixture;fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
