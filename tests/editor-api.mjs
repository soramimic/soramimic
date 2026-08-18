// 編集ツール向けlib API(getCandidates / 固定つき再生成)のテスト。
// 実行: node tests/editor-api.mjs (frontend/でnpm install済みであること)
import assert from "node:assert";
import fs from "node:fs";
import { buildApp } from "./golden/harness-lib.mjs";
import { Kanji } from "../frontend/src/lib/character.js";
import { KanaToSyllable } from "../frontend/src/lib/kanaToSyllable.js";

const print = console.log.bind(console);

// 本番「バランス」相当(#102)。h.app は VOWEL_RATIO 0.8 でスケール済みの行列を持つ。
// SAME_VOWEL/CONSONANT_REWARD の掛け算ハックは撤廃(monophoneタイブレーク行列)。
const PARAM = {
	VOWEL_RATIO: 0.8,
	// ン/ッ/ーの変換コストは母音準一致セル相当を vowelRatio に連動(実効=20×r)。#105
	// 本番配線(app.js / editor.js)と同じく VOWEL_RATIO から導出する。
	VARIATION_COST: 20 * 0.8,
	SAME_PHRASE_BREAK_REWARD: 0,
	MID_PHRASE_BREAK_PENALTY: 20,
	WORD_NUMBER_PENALTY: 20,
	DUPLICATE: false,
};

const h = await buildApp({ tokenizer: "kuromoji" });
const db = await h.buildWordlist({ file: "wordlists/pokemon.csv", dbtype: "tidy" });
const { soramimiMaker, textAnalyzer } = h.app;

// ---- 元歌詞表記: 発音に含めない空白・記号も表層順どおり保持する ----
// 1文字の英単語が複数モーラ(I=アイ)になる場合、後続空白は2番目のモーラへ
// 連結される。そのモーラから重複surfaceを除く際も空白まで消してはならない。
for (const [input, expectedSurface] of [
	["I love you", "I love you"],
	["Hello world", "Hello world"],
	["  I  love you  ", "  I  love you  "],
	["I 愛 you", "I 愛 you"],
	["I,  love!", "I,  love!"],
	["don't stop", "don't stop"],
	["I’m here", "I'm here"],
	["夢は 今も", "夢は 今も"],
	["｜love《ラブ》 you", "love you"],
]) {
	const inputTokens = textAnalyzer.tokenizeTogether([input])[0];
	const inputUnits = textAnalyzer.getYomiAndPhraseBreak(inputTokens);
	assert.equal(
		inputUnits.map((unit) => unit.surface_form).join(""),
		expectedSurface,
		`発音ユニットから元表記を復元できること: ${JSON.stringify(input)}`,
	);
}

const englishResults = await h.generate(["I love you"], db, { ...PARAM });
const englishFormat1 = makeResultText(englishResults, "1").split("\n");
assert.equal(englishFormat1[1], "I love you", "format 1で英語歌詞の空白を保持すること");
print("[ok] 元歌詞表記: 英語・連続空白・英日混在・アポストロフィ・行端・ルビを保持");

// allocatorの最重要不変条件: 細分化の成否にかかわらず表層順は変えない。
// 公開版では漢字→ジュウが「字=ジ / 漢=ュウ」になり、この条件を破っていた。
const kanjiAllocator = Kanji(
	JSON.parse(fs.readFileSync(new URL("../data/kanjiyomi.json", import.meta.url), "utf8")),
	KanaToSyllable(),
);
assert.deepEqual(
	kanjiAllocator.allocate("漢字", "ジュウ"),
	[["漢字", "ジュウ"]],
	"発音単位内部のジを字の読みとして採用しないこと",
);
assert.deepEqual(
	kanjiAllocator.allocate("深夜12時を", "シンヤジューニジヲ"),
	[["深", "シン"], ["夜", "ヤ"], ["12", "ジューニ"], ["時", "ジ"], ["を", "ヲ"]],
	"算用数字を含む読みも発音単位境界と表層順に沿って対応させること",
);
for (const [surface, yomi] of [
	["漢字", "ジュウ"],
	["深夜12時を", "シンヤジューニジヲ"],
	["学校", "ガッコウ"],
	["日本", "ニホン"],
]) {
	const allocation = kanjiAllocator.allocate(surface, yomi);
	assert.equal(
		allocation.map(([part]) => part).join(""), surface,
		`漢字アラインメントの表層順を保つこと: ${surface}(${yomi})`,
	);
	assert.ok(
		allocation.slice(1).every(([, partYomi]) => !/^[ァィゥェォヮャュョ]/.test(partYomi)),
		`小書きカナから始まる境界を作らないこと: ${surface}(${yomi})`,
	);
}
print("[ok] 漢字アラインメント: 表層順と拗音境界を保持");

// ---- getCandidates: 「カナダ」の候補上位が妥当か ----
const tokens = textAnalyzer.tokenizeTogether(["カナダ"])[0];
const units = textAnalyzer.getYomiAndPhraseBreak(tokens);
const target = units.map((v) => v.pronunciation);
const candidates = soramimiMaker.getCandidates(db, target, PARAM, 10);
assert.ok(Array.isArray(candidates) && candidates.length > 0, "候補が返ること");
// 既定 VOWEL_RATIO 0.8(母音ロック)では カナダ(ア・ア・ア)に母音一致する候補が上位。
// ヤバチャ = ヤ(ア)・バ(ア)・チャ(ア) で母音完全一致(#102 で更新)
assert.equal(candidates[0].surface, "ヤバチャ", "最良候補が母音ロック下の期待候補と一致");
assert.ok(candidates.length <= 10, "上限件数を守ること");
assert.ok(candidates.every((w) => typeof w.sim === "number"), "simスコア付き");
print("[ok] getCandidates: 上位候補=" +
	candidates.slice(0, 3).map((w) => w.surface).join(","));

// ---- 複数桁の算用数字を読み修正しても拗音を分割しない ----
// kuromojiは「12」を1トークンにするため、1桁限定の仮読み処理では発音ユニットが
// 0件になり、編集ツールから選択も修正もできなかった。
const numberTokens = textAnalyzer.tokenizeTogether(["12"])[0];
assert.equal(numberTokens.length, 1, "12が1トークンになる前提");
assert.equal(numberTokens[0].pronunciation, "イチニ", "複数桁にも編集用の仮読みが付くこと");
assert.ok(
	textAnalyzer.getYomiAndPhraseBreak(numberTokens).length > 0,
	"複数桁の数字が選択可能な発音ユニットになること",
);

// 読み推定APIなどが文脈に合う読みを返した場合は、桁読みで上書きしない。
const explicitNumberTokens = textAnalyzer.formatTokensList([[
	{
		surface_form: "12", basic_form: "12", reading: "ジュウニ",
		pronunciation: "ジュウニ", pos: "名詞", pos_detail_1: "数", word_position: 1,
	},
]])[0];
assert.equal(
	explicitNumberTokens[0].pronunciation, "ジュウニ",
	"解析器が返した複数桁数字の読みを桁読みで上書きしないこと",
);

// applyReadingFixと同じくpronunciationだけを書き換える。ジュを文字単位の
// ジ/ュへ割らず、候補検索と同じ音節単位にまとめること。
const correctedNumberTokens = numberTokens.map((token) => ({ ...token }));
correctedNumberTokens[0].pronunciation = "ジュウニ";
const correctedNumberUnits = textAnalyzer.getYomiAndPhraseBreak(correctedNumberTokens);
assert.deepEqual(
	correctedNumberUnits.map((unit) => unit.pronunciation),
	["ジュウ", "ニ"],
	"読み修正したジュウニを正しい音節単位に保つこと",
);
const numberCandidates = soramimiMaker.getCandidates(
	db, correctedNumberUnits.map((unit) => unit.pronunciation), PARAM, 10);
assert.ok(numberCandidates.length > 0, "数字の読み修正後に候補が返ること");
assert.ok(
	numberCandidates.every((candidate) => Number.isFinite(candidate.sim)),
	"数字の読み修正後の候補スコアが有限であること",
);

// 読み修正前の保存データなどで記号POSが残っていても、明示されたカナ読みは
// 無音記号として捨てずに復元できること。
const legacyNumberTokens = correctedNumberTokens.map((token) => ({ ...token, pos: "記号" }));
assert.deepEqual(
	textAnalyzer.getYomiAndPhraseBreak(legacyNumberTokens)
		.map((unit) => unit.pronunciation),
	["ジュウ", "ニ"],
	"記号POSに残った数字でも明示読みを尊重すること",
);
print("[ok] 算用数字の読み修正: 12(ジュウニ)の候補=" +
	numberCandidates.slice(0, 3).map((word) => word.surface).join(","));

// 公開版の報告操作。読みが欠落した12を周囲ごと選択して修正すると、
// 時=ジが先頭側の「ジ」に誤対応し、表層が深夜時12をへ逆転したうえで
// 残りが単独のュから分割されていた。
const mixedNumberTokens = textAnalyzer.formatTokensList([[
	{
		surface_form: "深夜12時を", basic_form: "深夜12時を", reading: "シンヤジヲ",
		pronunciation: "シンヤジューニジヲ", pos: "名詞", pos_detail_1: "一般", word_position: 1,
	},
]])[0];
const mixedNumberUnits = textAnalyzer.getYomiAndPhraseBreak(mixedNumberTokens);
assert.deepEqual(
	mixedNumberUnits.map((unit) => unit.pronunciation),
	["シン", "ヤ", "ジュー", "ニ", "ジ", "ヲ"],
	"数字と漢字の混在表層でも拗音を分割しないこと",
);
assert.equal(
	mixedNumberUnits.map((unit) => unit.surface_form).join(""),
	"深夜12時を",
	"数字の読み修正で表層順を逆転させないこと",
);
assert.ok(
	mixedNumberUnits.every((unit) => unit.pronunciation !== "ュ"),
	"数字と漢字の読み修正後に単独の小書きカナを残さないこと",
);
const mixedNumberCandidates = soramimiMaker.getCandidates(
	db, mixedNumberUnits.map((unit) => unit.pronunciation), PARAM, 10);
assert.ok(mixedNumberCandidates.length > 0, "深夜12時を、の読み修正後に候補が返ること");
assert.ok(
	mixedNumberCandidates.every((candidate) => Number.isFinite(candidate.sim)),
	"深夜12時を、の読み修正後の候補スコアが有限であること",
);
print("[ok] 公開版の算用数字読み修正: 深夜12時を(シンヤジューニジヲ)");

// 公開版での最小再現: 漢字(カンジ)の読みをジュウへ直すと、辞書の
// 字=ジが先頭一致して割当が「字=ジ / 漢=ュウ」と逆転していた。
const kanjiCorrectionTokens = textAnalyzer.formatTokensList([[
	{
		surface_form: "漢字", basic_form: "漢字", reading: "カンジ",
		pronunciation: "ジュウ", pos: "名詞", pos_detail_1: "一般", word_position: 1,
	},
]])[0];
const kanjiCorrectionUnits = textAnalyzer.getYomiAndPhraseBreak(kanjiCorrectionTokens);
assert.deepEqual(
	kanjiCorrectionUnits.map((unit) => unit.pronunciation),
	["ジュウ"],
	"複数漢字の読み修正でも拗音を分割しないこと",
);
assert.equal(
	kanjiCorrectionUnits.map((unit) => unit.surface_form).join(""),
	"漢字",
	"読み修正で表層順を逆転させないこと",
);
print("[ok] 複数漢字の読み修正: 漢字(ジュウ)");

// ---- 固定つき再生成 ----
const phrases = ["カナダ カナダ カナダ"];
const tokensList = textAnalyzer.tokenizeTogether(phrases);
const base = await new Promise((resolve) => {
	soramimiMaker.generateFromTokens(tokensList, db, { ...PARAM }, null, resolve);
});
assert.ok(base[0].length >= 2, "ベース生成で複数単語が出ること");

// 2番目の単語を別候補に差し替えて固定し、それ以外を再生成
const lockedSrc = base[0][1];
const altCandidates = soramimiMaker.getCandidates(
	db, lockedSrc.originalkana.split(""), PARAM, 5);
const alt = { ...altCandidates.find((w) => w.surface !== lockedSrc.surface) };
alt.period = lockedSrc.period;
alt.originalkana = lockedSrc.originalkana;
alt.original_surface = lockedSrc.original_surface;

const regen = await new Promise((resolve) => {
	soramimiMaker.generateFromTokens(
		tokensList, db, { ...PARAM }, null, resolve, [[alt]]);
});
const regenLine = regen[0];
const kept = regenLine.find(
	(w) => w.period[0] === alt.period[0] && w.period[1] === alt.period[1]);
assert.ok(kept, "固定単語のperiodが結果に存在すること");
assert.equal(kept.surface, alt.surface, "固定単語がそのまま残ること");
// 固定区間の外も埋まっている(区間が単語で覆われている)こと
const covered = regenLine.reduce((acc, w) => acc + (w.period[1] - w.period[0]), 0);
const baseCovered = base[0].reduce((acc, w) => acc + (w.period[1] - w.period[0]), 0);
assert.ok(covered >= baseCovered - 1, "固定以外の区間も生成されていること");
// DUPLICATE=false: 固定した単語は他の場所で再利用されないこと
assert.equal(
	regenLine.filter((w) => w.id === alt.id).length, 1,
	"固定単語が重複採用されないこと");
// DUPLICATE=false: 固定の前後の区間どうしでも単語が重複しないこと
const ids = regenLine.map((w) => w.id);
assert.equal(new Set(ids).size, ids.length, "行内で単語IDが重複しないこと");
print("[ok] 固定つき再生成: " +
	regenLine.map((w) => (w === kept ? "🔒" : "") + w.surface).join(" / "));

// ---- 自動生成の単語境界は文字の途中に入らない ----
// 「赤とんぼ × 駅名」で実際に発生した回帰: 畑=ハ・タ・ケの途中で
// 山の畑(ヤマノハ) / の、(タケノ) と分かれ、元歌詞読みが「は／のけ」に崩れていた。
const stationDb = await h.buildWordlist({
	file: "wordlists/stations.csv", dbtype: "tidy", where: "status=current",
});
const akatomboTokens = textAnalyzer.tokenizeTogether(["山の畑の、桑の実を"]);
const akatomboUnits = textAnalyzer.getYomiAndPhraseBreak(akatomboTokens[0]);
const akatombo = await new Promise((resolve) => {
	soramimiMaker.generateFromTokens(
		akatomboTokens, stationDb, { ...PARAM }, null, resolve);
});
for (const word of akatombo[0]) {
	for (const boundary of word.period) {
		if (boundary === 0 || boundary === akatomboUnits.length) continue;
		assert.notEqual(
			akatomboUnits[boundary - 1].char_index,
			akatomboUnits[boundary].char_index,
			`文字途中に単語境界がある: ${word.surface} ${JSON.stringify(word.period)}`,
		);
	}
}
print("[ok] 文字境界: 畑の読みを分割しない");

print("編集ツールAPI: 全テスト通過");
