// 小書きカナ(「ハァ」「ウッセェ」など)の吸収テスト。
//
// 単独の小書きカナは単語リストの発音には現れない(単語側はformatKanaで正規化済み)ため、
// 歌詞の読みに残ると、そのユニットに一致する単語がなく行全体の候補が0件になる。
// 「うっせぇわ」のサビが1件も変換できなかったのがこれ。
//
// 実行: node tests/small-kana.mjs (frontend/でnpm ci済みであること)
import assert from "node:assert";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./golden/harness-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { absorbSmallKana, KanaToSyllable } = await import(
	pathToFileURL(path.join(ROOT, "frontend/src/lib/kanaToSyllable.js")).href);

const print = console.log.bind(console);

const PARAM = {
	VOWEL_RATIO: 0.8,
	VARIATION_COST: 20 * 0.8,
	SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 20,
	WORD_NUMBER_PENALTY: 20,
	DUPLICATE: true,
};

// ---- absorbSmallKana: 1モーラを作らない小書きは大文字化、作るものは温存 ----
const CASES = [
	// 同母音の引き伸ばし表記 → 大文字
	["ウッセェワ", "ウッセエワ"],
	["ハァ", "ハア"],
	["リィ", "リイ"],
	["スゥ", "スウ"],
	["ノォ", "ノオ"],
	// 1モーラを構成する組み合わせ → そのまま
	["ディズニー", "ディズニー"],
	["ティラミス", "ティラミス"],
	["ファイト", "ファイト"],
	["ウィスキー", "ウィスキー"],
	["シェフ", "シェフ"],
	["チェック", "チェック"],
	["トゥース", "トゥース"],
	["キャンプ", "キャンプ"],
	["ジョギング", "ジョギング"],
	["ヴァイオリン", "ヴァイオリン"],
	// 単独で現れた小書き → 大文字
	["ァ", "ア"],
	["ェェ", "エエ"],
	["ンョ", "ンヨ"],
	// 連続する小書き(1つ目だけくっつく)
	["ヴァァ", "ヴァア"],
	["ファァァ", "ファアア"],
	// ひらがなも同じ規則で、ひらがなのまま直す
	["うっせぇわ", "うっせえわ"],
	["はぁ", "はあ"],
	["しぇふ", "しぇふ"],
	["ちょきん", "ちょきん"],
	// 促音・長音・小書き以外には触らない
	["ウッ", "ウッ"],
	["カーッ", "カーッ"],
	["カタカナ", "カタカナ"],
	["", ""],
];
for (const [input, expected] of CASES) {
	assert.equal(absorbSmallKana(input), expected, `absorbSmallKana(${input})`);
	assert.equal(absorbSmallKana(input).length, input.length,
		`長さが変わらないこと(${input})`);
}
print(`[ok] absorbSmallKana: ${CASES.length}ケース`);

// 残した組み合わせは音節分割でも1ユニットになること(分かれると単独の小書きが残る)
const k2s = KanaToSyllable();
const STICKY = [
	"ウァ", "クィ", "スェ", "ツォ", "ヌァ", "フェ", "ムォ", "ユァ", "ルィ",
	"グェ", "ズォ", "ヅァ", "ブィ", "プェ", "ヴァ",
	"テャ", "ティ", "テュ", "テョ", "デャ", "ディ", "デュ", "デョ",
	"イャ", "キャ", "シュ", "チョ", "ニャ", "ヒュ", "ミョ", "リャ",
	"ギュ", "ジョ", "ヂャ", "ビュ", "ピョ",
	"キェ", "シェ", "チェ", "ニェ", "ヒェ", "ミェ", "リェ", "ギェ", "ジェ",
	"ヂェ", "ビェ", "ピェ",
	"トゥ", "ドゥ",
];
for (const pair of STICKY) {
	assert.equal(absorbSmallKana(pair), pair, `温存されること(${pair})`);
	const units = k2s.split(pair);
	assert.deepEqual(units, [pair], `1ユニットに分割されること(${pair})`);
}
// 逆に、吸収後のかなには単独の小書きユニットが残らないこと
const SMALL = /^[ァィゥェォヮャュョ]$/;
for (const text of ["ウッセェワ", "ハァ", "リィ", "イェーガー", "クヮ", "ヴァァ", "ェ"]) {
	const units = k2s.split(absorbSmallKana(text)) || [];
	assert.ok(units.every((u) => !SMALL.test(u)),
		`単独の小書きユニットが残らないこと(${text} → ${JSON.stringify(units)})`);
}
print(`[ok] 音節分割との整合: 温存${STICKY.length}組 / 単独小書きの残留なし`);

// ---- トークナイズの入口で吸収されること ----
const h = await buildApp();
const { textAnalyzer, soramimiMaker } = h.app;

function unitsOf(line) {
	const tokens = textAnalyzer.tokenizeTogether([line])[0];
	return textAnalyzer.getYomiAndPhraseBreak(tokens).map((u) => u.pronunciation);
}
assert.deepEqual(unitsOf("ウッセェワ"), ["ウッ", "セエ", "ワ"], "カタカナ入力の読み");
assert.deepEqual(unitsOf("うっせぇわ"), ["ウッ", "セエ", "ワ"], "ひらがな入力の読み");
assert.deepEqual(unitsOf("ハァ"), ["ハア"], "ハァの読み");
assert.deepEqual(unitsOf("シェフ"), ["シェ", "フ"], "シェは1モーラのまま");
// 表層(元歌詞の表記)は変えない
const surfaces = textAnalyzer.tokenizeTogether(["うっせぇわ"])[0].map((t) => t.surface_form);
assert.equal(surfaces.join(""), "うっせぇわ", "表層は元の表記のまま");
print("[ok] tokenizeTogether: 読みの小書きが吸収され、表層はそのまま");

// ---- 統合: 「うっせぇわ」のサビが変換できること ----
const db = h.buildWordlist({
	file: "tests/golden/fixtures/wordlists/pokemon.csv",
	dbtype: "tidy",
});
const phrases = ["ハァ うっせぇうっせぇうっせぇわ", "ウッセェワ"];
const results = await h.generate(phrases, db, PARAM);
assert.equal(results.length, phrases.length, "行数");
results.forEach((words, i) => {
	assert.ok(Array.isArray(words) && words.length > 0,
		`候補が返ること(${phrases[i]})`);
});
print("[ok] 変換: " + results.map((ws) => ws.map((w) => w.surface).join("")).join(" / "));

print("すべて成功");
