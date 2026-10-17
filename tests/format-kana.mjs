// formatKana の英字カナ化テスト。
//
// かつては /[a-zA-Z']+/g の置換コールバックが match ではなく text 全体を toKana して
// 返していたため、英字が k 箇所ある文字列の読みがおよそ k+1 倍に膨張していた。
// 膨張した読みはユニット数が増え、後段の音節バリエーション展開が指数爆発する
// (単語リスト構築が数分かかっていた原因)。
//
// 実行: node tests/format-kana.mjs (frontend/でnpm ci済みであること)
import assert from "node:assert";
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libUrl = (f) => pathToFileURL(path.join(ROOT, "frontend/src/lib", f)).href;
const loadJson = (f) => JSON.parse(readFileSync(path.join(ROOT, "data", f), "utf8"));

const { createSoramimic } = await import(libUrl("index.js"));

const print = console.log.bind(console);
// createSoramimic 配下のログでテスト出力が埋もれないよう黙らせる
console.log = () => {};
console.time = () => {};
console.timeEnd = () => {};

// formatKana はトークナイザを使わないので、注入は throw するダミーで足りる
const app = createSoramimic({
	kanjiDict: loadJson("kanjiyomi.json"),
	englishDict: loadJson("english-kana.json"),
	romanTree: loadJson("tree_roma2kana.json"),
	vowelSimilarity: loadJson("simVowelsSimple.json"),
	consonantSimilarity: loadJson("simConsonantsSimple.json"),
	kana2phonon: loadJson("kana2phonon.json"),
	tokenizeSentenses: () => { throw new Error("tokenize は呼ばれない想定"); },
	getYomi: (t) => t,
});
const { formatKana } = app.textAnalyzer;

// ---- 英字マッチはマッチした部分だけがカナ化される ----
const CASES = [
	// 英字のみ
	["cat", "キャット"],
	["love", "ラヴ"],
	["X", "エクス"],
	// カナ・かなはそのまま(全角英字は [a-zA-Z] にマッチせず removeSign で半角化される)
	["ネコ", "ネコ"],
	["こんにちは", "コンニチハ"],
	["ｃａｔ", "cat"],
	// 日本語混じり: 英字部分だけが置き換わり、周りの文字は保持される
	["メガリザードンX", "メガリザードンエクス"],
	["ポケモンGO", "ポケモンゴー"],
	["ミュウツーY", "ミュウツーワイ"],
	// 英字が複数箇所
	["AとBとC", "エイトビートシー"],
	["Ma's night monkey", "マエスナイトモンキー"],
	["Red-Throated Rainbow-Skink(アカノドニジトカゲ)",
		"レッドスローテッドレインボーエスキンケイアカノドニジトカゲ"],
];
for (const [input, expected] of CASES) {
	assert.equal(formatKana(input), expected, `formatKana(${input})`);
}
print(`[ok] formatKana: ${CASES.length}ケース`);

// ---- 英字が複数箇所あっても読みが膨張しない ----
// 「英字1箇所の読み」を並べただけの長さに収まること(k+1倍化の再発検知)
const JP = "アカノドニジトカゲ";
assert.equal(formatKana("Red" + JP), "レッド" + JP);
assert.equal(formatKana("Red" + JP + "Blue"), "レッド" + JP + "ブルー");
assert.equal(formatKana("Red" + JP + "Blue" + JP + "Green"),
	"レッド" + JP + "ブルー" + JP + "グリーン");

// 英字を1箇所ずつ増やしても、増分は追加した語の読み長だけ(全体の再カナ化ではない)
let prev = formatKana("A" + JP);
for (let k = 2; k <= 5; k++) {
	const cur = formatKana(Array(k).fill("A").join(JP));
	const grew = cur.length - prev.length;
	assert.ok(grew <= JP.length + 4,
		`英字${k}箇所で読みが膨張しないこと(+${grew}文字: ${cur})`);
	prev = cur;
}
print("[ok] 英字が複数箇所あっても読みが膨張しない");

print("すべて成功");
