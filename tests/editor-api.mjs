// 編集ツール向けlib API(getCandidates / 固定つき再生成)のテスト。
// 実行: node tests/editor-api.mjs (frontend/でnpm install済みであること)
import assert from "node:assert";
import { buildApp } from "./golden/harness-lib.mjs";

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
const db = h.buildWordlist({ file: "wordlists/pokemon.csv", dbtype: "tidy" });
const { soramimiMaker, textAnalyzer } = h.app;

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

print("編集ツールAPI: 全テスト通過");
