import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const [repository, fixtures] = process.argv.slice(2);
const print = console.log.bind(console);
const { buildApp } = await import(pathToFileURL(path.join(repository, 'tests/golden/harness-lib.mjs')));
const { app } = await buildApp();
const param = { VOWEL_RATIO: 0.8, VARIATION_COST: 16, SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 20, WORD_NUMBER_PENALTY: 20, DUPLICATE: false };
// Both revisions receive the candidate checkout's frozen, already tracked corpus.
const read = file => fs.readFileSync(path.join(fixtures, file), 'utf8');
const baseball = await app.wordList.parseTidy(read('tests/golden/fixtures/wordlists/baseball.csv'),
	'type=family or type=registered or type=full');
const pokemon = await app.wordList.parseTidy(read('tests/golden/fixtures/wordlists/pokemon.csv'));
const ordinary = read('sample_lyric/moshikame.txt').trim().split(/\r?\n/).slice(0, 4);
const preferences = [...new Map(Object.values(pokemon).flat()
	.filter(word => ['ピカチュウ', 'イーブイ', 'デデンネ'].includes(word.surface))
	.map(word => [word.surface, { id: word.id, original: word.original, surface: word.surface, scope: 'word' }])).values()];
assert.equal(preferences.length, 3, 'priority fixture must resolve all three words');
const cases = [
	{ name: 'ordinary-unique', db: baseball, phrases: ordinary },
	{ name: 'ordinary-duplicate', db: baseball, phrases: ordinary, extra: { DUPLICATE: true } },
	{ name: 'long-vowels', db: pokemon, phrases: ['ゴメンネ サンタサン ホッケー',
		'コーヒー ケーキ パーティー', 'スーパー ヒーロー ストーリー', 'グーグー グーグー グーグーグー'] },
	{ name: 'priority-12-lines', db: pokemon, phrases: Array.from({ length: 3 }, () => ordinary).flat(),
		extra: { PRIORITY_WORDS: preferences } },
];
const output = {};
for (const item of cases) {
	const generate = () => new Promise((resolve, reject) => {
		const handle = app.soramimiMaker.generate(item.phrases, item.db,
			{ ...param, ...item.extra }, null, resolve);
		handle?.finished?.catch(reject);
	});
	// Warm the JIT and tokenizer on the exact workload before measuring generation.
	await generate();
	const cpuStart = process.cpuUsage();
	const wallStart = performance.now();
	const result = await generate();
	const wallMs = performance.now() - wallStart;
	const cpu = process.cpuUsage(cpuStart);
	assert.equal(result.length, item.phrases.length, `${item.name}: missing output lines`);
	assert(result.every(line => line.length > 0), `${item.name}: empty output`);
	if (item.extra?.PRIORITY_WORDS) {
		for (const preference of preferences) {
			assert(result.flat().some(word => word.id === preference.id), 'priority word was not placed');
		}
	}
	output[item.name] = { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 };
}
print(JSON.stringify(output));
