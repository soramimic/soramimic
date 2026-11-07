import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compare, MAX_SLOWDOWN, NOISE_FLOOR_MS } from './compare.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const options = {};
while (args.length) {
	const key = args.shift();
	if (!['--base', '--head', '--report', '--samples'].includes(key) || !args.length) {
		throw new Error('Usage: node tests/performance/run.mjs --base CHECKOUT [--head CHECKOUT] [--samples 5] [--report FILE]');
	}
	options[key] = args.shift();
}
if (!options['--base']) throw new Error('--base CHECKOUT is required');
const samples = Number(options['--samples'] ?? 5);
if (!Number.isInteger(samples) || samples < 3 || samples > 15) throw new Error('--samples must be 3..15');
const repositories = { base: path.resolve(options['--base']), head: path.resolve(options['--head'] ?? root) };
const results = { base: {}, head: {} };
for (let round = 0; round < samples; round++) {
	// Run sequentially, reversing order each round to reduce machine-load bias.
	for (const label of round % 2 ? ['head', 'base'] : ['base', 'head']) {
		const { stdout } = await exec(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)),
			repositories[label], root], { timeout: 180_000, maxBuffer: 1024 * 1024 });
		const timings = JSON.parse(stdout);
		for (const [name, timing] of Object.entries(timings)) (results[label][name] ??= []).push(timing);
		console.log(`[${round + 1}/${samples}] ${label}: ${Object.entries(timings)
			.map(([name, timing]) => `${name} ${timing.wallMs.toFixed(0)}ms`).join(', ')}`);
	}
}
const comparison = compare(results.base, results.head);
const revisions = {};
for (const [label, cwd] of Object.entries(repositories)) {
	revisions[label] = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
}
const report = { revisions, node: process.version, platform: `${os.platform()} ${os.arch()}`,
	cpu: os.cpus()[0]?.model, samples, maxSlowdown: MAX_SLOWDOWN, noiseFloorMs: NOISE_FLOOR_MS,
	results, comparison };
if (options['--report']) {
	const destination = path.resolve(options['--report']);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
}
const table = ['### Generation performance', '',
	'Case | Wall time (base → head) | CPU time (base → head) | Result',
	'--- | ---: | ---: | ---'];
const format = metric => `${metric.base.toFixed(0)} → ${metric.head.toFixed(0)} ms (${metric.ratio.toFixed(2)}×)`;
for (const row of comparison) {
	table.push(`${row.name} | ${format(row.metrics.wallMs)} | ${format(row.metrics.cpuMs)} | ${row.regressed ? 'FAIL' : 'PASS'}`);
}
table.push('', 'Median of paired runs after warm-up; fail above 30% AND the noise floor (wall: 100 ms, CPU: 50 ms).',
	`Base: ${revisions.base}; head: ${revisions.head}.`, '');
console.log(table.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table.join('\n'));
if (comparison.some(row => row.regressed)) process.exitCode = 1;
