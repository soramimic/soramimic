// ルビ記法(｜表層《よみ》)のテスト。
// パーサ単体(parseRuby)と、トークナイズ入口(tokenizeTogether)での読み上書きを検証する。
//
// 実行: node tests/ruby.mjs (frontend/でnpm ci済みであること)
import assert from "node:assert";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildApp } from "./golden/harness-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseRuby, hasRuby } = await import(
	pathToFileURL(path.join(ROOT, "frontend/src/lib/ruby.js")).href);

const print = console.log.bind(console);

// [入力, 期待plain, 期待annotations] — Python側 tests/test_ruby.py と同一ケース
const PARSE_CASES = [
	// --- 記法なし(素通し) ---
	["夢は今もめぐりて 忘れがたきふるさと", "夢は今もめぐりて 忘れがたきふるさと", []],
	["", "", []],
	// --- 基本形 ---
	["｜邪悪《ダークネス》を飼い慣らせ", "邪悪を飼い慣らせ",
		[{ start: 0, end: 2, reading: "ダークネス" }]],
	// 開始記号は半角 | も受理する
	["|邪悪《ダークネス》を飼い慣らせ", "邪悪を飼い慣らせ",
		[{ start: 0, end: 2, reading: "ダークネス" }]],
	// 読みのひらがなはカタカナに正規化する(それ以外はそのまま)
	["｜本気《まじ》", "本気", [{ start: 0, end: 2, reading: "マジ" }]],
	["｜本気《マジ》", "本気", [{ start: 0, end: 2, reading: "マジ" }]],
	["｜延《の》ーばす", "延ーばす", [{ start: 0, end: 1, reading: "ノ" }]],
	// 行の途中・末尾
	["俺の｜心《ハート》", "俺の心", [{ start: 2, end: 3, reading: "ハート" }]],
	// 複数ルビ
	["｜本気《マジ》で｜書く《かく》ぜ", "本気で書くぜ",
		[{ start: 0, end: 2, reading: "マジ" }, { start: 3, end: 5, reading: "カク" }]],
	// 隣接ルビ
	["｜A《エー》｜B《ビー》", "AB",
		[{ start: 0, end: 1, reading: "エー" }, { start: 1, end: 2, reading: "ビー" }]],
	// --- エスケープ ---
	// \｜ は文字そのもの(記法として解釈しない)
	["\\｜邪悪《ダークネス》", "｜邪悪《ダークネス》", []],
	["\\|邪悪《ダークネス》", "|邪悪《ダークネス》", []],
	// 表層・読みの中でもエスケープが効く
	["｜a\\｜b《ヨミ》", "a｜b", [{ start: 0, end: 3, reading: "ヨミ" }]],
	["｜表層《よ\\《み》", "表層", [{ start: 0, end: 2, reading: "ヨ《ミ" }]],
	["｜表層《よ\\》み》", "表層", [{ start: 0, end: 2, reading: "ヨ》ミ" }]],
	// \\ はバックスラッシュ1文字、それ以外の前の \ はそのまま文字
	["a\\\\b", "a\\b", []],
	["a\\b", "a\\b", []],
	["末尾は\\", "末尾は\\", []],
	["\\\\｜邪悪《ダーク》", "\\邪悪", [{ start: 1, end: 3, reading: "ダーク" }]],
	// --- 寛容規則 ---
	// 《よみ》が続かない ｜ は通常文字
	["｜ふつうの文字", "｜ふつうの文字", []],
	["｜邪悪だ", "｜邪悪だ", []],
	// 表層は「｜から《まで」なので空白も含む(改行以外の終端は無い)
	["｜邪悪 《ダークネス》", "邪悪 ", [{ start: 0, end: 3, reading: "ダークネス" }]],
	// ｜を伴わない 《…》 は通常文字(暗黙形は未対応)
	["邪悪《ダークネス》", "邪悪《ダークネス》", []],
	["《ダークネス》", "《ダークネス》", []],
	// 読みが空 / 表層が空は無効
	["｜表層《》", "｜表層《》", []],
	["｜《ヨミ》", "｜《ヨミ》", []],
	// ネスト不可: 後ろの ｜ が勝ち、前の ｜ は通常文字
	["｜a｜b《ヨミ》", "｜ab", [{ start: 2, end: 3, reading: "ヨミ" }]],
	// 改行をまたぐ記法は無効
	["｜邪悪\n《ダークネス》", "｜邪悪\n《ダークネス》", []],
	["｜邪悪《ダーク\nネス》", "｜邪悪《ダーク\nネス》", []],
	// 閉じ括弧が無い / 括弧の入れ子
	["｜邪悪《ダークネス", "｜邪悪《ダークネス", []],
	["｜a《b《ヨミ》", "｜a《b《ヨミ》", []],
	// --- オフセットはコードポイント単位(UTF-16のsurrogate pairに注意) ---
	["𩸽｜邪悪《ダーク》", "𩸽邪悪", [{ start: 1, end: 3, reading: "ダーク" }]],
	["｜𩸽《ホッケ》を焼く", "𩸽を焼く", [{ start: 0, end: 1, reading: "ホッケ" }]],
];

let failed = 0;
for (const [input, expectedPlain, expectedAnns] of PARSE_CASES) {
	const got = parseRuby(input);
	try {
		assert.strictEqual(got.plain, expectedPlain, `plain: ${JSON.stringify(input)}`);
		assert.deepStrictEqual(got.annotations, expectedAnns,
			`annotations: ${JSON.stringify(input)}`);
	} catch (e) {
		failed += 1;
		console.error(`[FAIL] ${e.message}\n  got=${JSON.stringify(got)}`);
	}
}
print(`parseRuby: ${PARSE_CASES.length - failed}/${PARSE_CASES.length} 件一致`);

assert.strictEqual(hasRuby("｜本気《マジ》"), true);
assert.strictEqual(hasRuby("本気《マジ》"), false);

// ---- トークナイズ入口での読み上書き(kuromoji経路) ----
const harness = await buildApp();
const ta = harness.app.textAnalyzer;

function yomiOf(tokens) {
	return tokens.map((t) => (t.pronunciation === "*" ? "" : t.pronunciation)).join("");
}

// 1. 注釈区間が強制トークン1個になり、読みが指定どおりになる
{
	const [tokens] = ta.tokenizeTogether(["｜邪悪《ダークネス》を飼い慣らせ"]);
	const ruby = tokens.filter((t) => t.ruby);
	assert.strictEqual(ruby.length, 1, "強制トークンは1個");
	assert.strictEqual(ruby[0].surface_form, "邪悪");
	assert.strictEqual(ruby[0].pronunciation, "ダークネス");
	assert.strictEqual(ruby[0].reading, "ダークネス");
	assert.strictEqual(ruby[0].pos, "名詞");
	assert.strictEqual(tokens.map((t) => t.surface_form).join(""), "邪悪を飼い慣らせ");
	assert.ok(yomiOf(tokens).startsWith("ダークネス"), yomiOf(tokens));
	// word_positionは結合後に再計算される(1始まり・表層の累積コードポイント数)
	assert.deepStrictEqual(tokens.map((t) => t.word_position),
		tokens.reduce((acc, t) => {
			acc.list.push(acc.pos);
			acc.pos += [...t.surface_form].length;
			return acc;
		}, { pos: 1, list: [] }).list);
}

// 2. かな表層・英字表層でも指定した読みが後段の推定に上書きされない
for (const [input, surface, reading] of [
	["｜すもも《ピーチ》が好き", "すもも", "ピーチ"],
	["｜love《アイ》を叫ぶ", "love", "アイ"],
	["｜1《ワン》の位", "1", "ワン"],
	["｜あ《ハート》っ", "あ", "ハート"],
]) {
	const [tokens] = ta.tokenizeTogether([input]);
	const ruby = tokens.filter((t) => t.ruby);
	assert.strictEqual(ruby.length, 1, input);
	assert.strictEqual(ruby[0].surface_form, surface, input);
	assert.strictEqual(ruby[0].pronunciation, reading, `${input}: ${ruby[0].pronunciation}`);
}

// 3. 後方互換: 記法を含まない行はルビ処理の前後で出力が完全一致する
{
	const plain = ["夢は今もめぐりて 忘れがたきふるさと", "ぴえんー! 超えもい", "1じにあっ"];
	const viaRuby = ta.tokenizeTogether(plain);
	// splitByRubyが行全体を1チャンクにしていること(=トークナイザ入力が従来と同一)
	const { chunks, plan } = ta.splitByRuby(plain);
	assert.deepStrictEqual(chunks, plain);
	assert.deepStrictEqual(plan, plain.map((_, i) => [{ type: "chunk", index: i }]));
	assert.ok(viaRuby.every((tokens) => tokens.every((t) => !t.ruby)));
}

// 4. 記法を含む行と含まない行が混在しても行の対応が崩れない
{
	const tokensList = ta.tokenizeTogether(["普通の行", "｜本気《マジ》で", "", "また普通"]);
	assert.strictEqual(tokensList.length, 4);
	assert.strictEqual(tokensList[1].filter((t) => t.ruby).length, 1);
	assert.strictEqual(tokensList[2].length, 0);
	assert.strictEqual(tokensList[0].filter((t) => t.ruby).length, 0);
}

// 5. 生成まで通る(DPが強制トークンの読みを使う)
{
	const db = harness.buildWordlist({
		file: "tests/golden/fixtures/wordlists/nations.csv", dbtype: "tidy", where: "",
	});
	const results = await harness.generate(["｜邪悪《ダークネス》"], db, { VOWEL_RATIO: 0.8 });
	assert.ok(results && results.length === 1, "1行分の結果が返る");
}

if (failed > 0) {
	console.error(`${failed}件失敗`);
	process.exit(1);
}
print("ruby: 全ケース一致");
