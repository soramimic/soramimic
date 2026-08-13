// 音節バリエーションの最大ユニット数による早期枝刈りテスト。
//
// 実行: node tests/variation-pruning.mjs
import assert from "node:assert";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libUrl = (file) => pathToFileURL(path.join(ROOT, "frontend/src/lib", file)).href;
const { KanaToSyllable } = await import(libUrl("kanaToSyllable.js"));
const { TextAnalyzer } = await import(libUrl("textAnalyzer.js"));

const print = console.log.bind(console);
const snapshot = (variations) => variations.map((v) => ({
	units: Array.from(v),
	vcost: v.vcost,
	srcIndex: v.srcIndex,
}));

const k2s = KanaToSyllable();

// ---- maxUnits 省略時は従来の内容・付加プロパティ・順序を保つ ----
const expectedLegacy = [
	{ units: ["カ", "ン", "コ"], vcost: 0, srcIndex: [0, 0, 1] },
	{ units: ["カー", "コ"], vcost: 1, srcIndex: [0, 1] },
	{ units: ["カ", "コ"], vcost: 1, srcIndex: [0, 1] },
];
assert.deepEqual(snapshot(k2s.getVariation(["カン", "コ"])), expectedLegacy);
assert.deepEqual(snapshot(k2s.getVariation(["カン", "コ"], undefined)), expectedLegacy,
	"undefined の明示指定も省略時と同じ");
print("[ok] maxUnits省略時は従来の内容・プロパティ・順序を維持");

// ---- 上限つき結果は従来結果を長さで絞ったものと完全に一致する ----
const branching = ["ンッ", "カン", "アッ", "ン"];
const legacy = k2s.getVariation(branching);
for (const maxUnits of [0, 1, 2, 3, 5]) {
	const expected = legacy.filter((v) => v.length <= maxUnits);
	assert.deepEqual(snapshot(k2s.getVariation(branching, maxUnits)), snapshot(expected),
		`maxUnits=${maxUnits}: 従来結果のfilterと一致`);
}
print("[ok] 上限つき結果は従来結果の長さfilterと一致");

// TextAnalyzer の読みAPIからも同じ上限が引き渡されること。
const originalLog = console.log;
console.log = () => {};
const textAnalyzer = TextAnalyzer({ kanji: {} }, k2s, {}, () => [], (v) => v);
console.log = originalLog;
const yomi = "ンッカンアッン";
const yomiLegacy = textAnalyzer.yomiToVariation(yomi);
assert.deepEqual(snapshot(textAnalyzer.yomiToVariation(yomi, 2)),
	snapshot(yomiLegacy.filter((v) => v.length <= 2)));
assert.deepEqual(snapshot(textAnalyzer.yomiToVariation(yomi)), snapshot(yomiLegacy),
	"TextAnalyzerでも上限省略時は不変");
print("[ok] TextAnalyzer.yomiToVariationがmaxUnitsを伝播");

// ---- 高分岐でも小さい上限なら組合せ全体を展開しない ----
// 「ンッ」18個の素朴な直積は4^18 (約687億) 通り。maxUnits=1なら有効なのは
// 各位置から「ン」か「ッ」を1つだけ残す36通りだけで、早期枝刈りなら即座に終わる。
// 退行時に親テストプロセスまでメモリ不足にしないよう、このケースだけ子プロセスで実行する。
const stressScript = `
	import { KanaToSyllable } from ${JSON.stringify(libUrl("kanaToSyllable.js"))};
	const input = Array(18).fill("ンッ");
	const result = KanaToSyllable().getVariation(input, 1);
	if (result.length !== 36) throw new Error("unexpected count: " + result.length);
	if (!result.every((v) => v.length === 1 && v.srcIndex.length === 1)) {
		throw new Error("invalid bounded variation");
	}
`;
const execFileAsync = promisify(execFile);
await execFileAsync(process.execPath, ["--input-type=module", "--eval", stressScript], {
	timeout: 3000,
	maxBuffer: 1024 * 1024,
});
print("[ok] 4^18通り相当の高分岐入力をmaxUnits=1で早期枝刈り");

print("すべて成功");
