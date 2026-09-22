#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const server = readJson('server.json');
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const problems = [];

for (const [surface, version] of [
  ['package-lock.json top level', lock.version],
  ['package-lock.json root package', lock.packages?.['']?.version],
  ['server.json', server.version],
  ['server.json npm package', server.packages?.find(e => e.registryType === 'npm')?.version],
]) if (version !== pkg.version) problems.push(`${surface} is ${version ?? 'missing'}, expected ${pkg.version}`);

if (pkg.mcpName !== server.name) problems.push(`package.json mcpName is ${pkg.mcpName}, expected ${server.name}`);
if ((server.description?.length ?? 0) > 100) problems.push(`server.json description is ${server.description.length} chars; registry maximum is 100`);
for (const f of ['server.json', 'spec', 'schemas', 'conformance']) if (!pkg.files?.includes(f)) problems.push(`package.json files does not ship ${f}`);
if (pkg.publishConfig?.access !== 'public') problems.push('publishConfig.access must be public');
if (!changelog.includes(`## v${pkg.version}`)) problems.push(`CHANGELOG.md has no section for v${pkg.version}`);
if (!readme.includes('spec/00-principles.md')) problems.push('README.md must link the principles');

const surface = spawnSync(process.execPath, ['dist/index.js', 'tools', '--json'], { encoding: 'utf8', timeout: 10_000 });
if (surface.status !== 0) problems.push(`tools --json exited ${surface.status}: ${surface.stderr.trim()}`);
else {
  try {
    const names = JSON.parse(surface.stdout).tools?.map(t => t.name) ?? [];
    for (const n of ['monitor_discover', 'monitor_create', 'monitor_publish', 'monitor_state', 'monitor_subscribe', 'monitor_pull', 'monitor_ack', 'lease_claim'])
      if (!names.includes(n)) problems.push(`tool surface lacks ${n}`);
  } catch (e) { problems.push(`tools --json is not JSON: ${e.message}`); }
}
if (problems.length) { console.error(`Release contract failed — ${problems.length} problem(s):`); for (const p of problems) console.error(`- ${p}`); process.exit(1); }
console.log(`Release contract OK for ${pkg.name}@${pkg.version}`);
