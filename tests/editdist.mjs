// ン・ッ・ーの編集距離一貫性テスト(#105)。
// 変種コスト導入とスコア正規化廃止により、ン/ッ/ー の挿入・削除・相互置換が
// すべて「準一致1操作」に統一されることを、カ系7語の49ペア実測で検証する。
// 実行: node tests/editdist.mjs (frontend/でnpm install済みであること)
import assert from "node:assert";
import { buildApp } from "./golden/harness-lib.mjs";

const print = console.log.bind(console);

// r=0.8(本番既定「バランス」)。VARIATION_COST=20×r=16 は母音準一致セル
// (名目20→実効16)と同値で、1変換操作=1準一致セルに揃う(#105)。
const R = 0.8;
const NEAR = 20 * R; // 準一致1操作の実効コスト = 16
const PARAM = { VOWEL_RATIO: R, VARIATION_COST: 20 * R, DUPLICATE: false };

// カ系7語。ン/ッ/ー を「同位置(1操作)」「位置違い(2操作)」で網羅する。
const WORDS = ["カッカ", "カカッ", "カンカ", "カカン", "カーカ", "カカー", "カカ"];

// 期待sim行列(report10 C20raw)。対角=0 / 同位置1操作=16 / 位置違い2操作=32。
// 完全対称。行=ターゲット, 列=候補, 単位は実効コスト(NEAR=16基準)。
const N = NEAR;
const T = 2 * NEAR;
const EXPECTED = [
	//        カッカ カカッ カンカ カカン カーカ カカー カカ
	/*カッカ*/[0, T, N, T, N, T, N],
	/*カカッ*/[T, 0, T, N, T, N, N],
	/*カンカ*/[N, T, 0, T, N, T, N],
	/*カカン*/[T, N, T, 0, T, N, N],
	/*カーカ*/[N, T, N, T, 0, T, N],
	/*カカー*/[T, N, T, N, T, 0, N],
	/*カカ */[N, N, N, N, N, N, 0],
];

const h = await buildApp({ tokenizer: "kuromoji" });
const { soramimiMaker, textAnalyzer } = h.app;
const db = h.app.wordList.parsePlain(WORDS.join("\n"));

// 各ターゲット語について全7語への sim を取得し、49ペアを検証する。
const TOL = 0.5; // 準一致値は実測で 16.0/32.0 と整数化するので厳しめ
let checked = 0;
for (let i = 0; i < WORDS.length; i++) {
	const target = textAnalyzer.yomiToSyllable(WORDS[i]);
	const cands = soramimiMaker.getCandidates(db, target, PARAM, 50);
	const sim = {};
	for (const c of cands) sim[c.surface] = c.sim;

	for (let j = 0; j < WORDS.length; j++) {
		const got = sim[WORDS[j]];
		const want = EXPECTED[i][j];
		assert.ok(
			got !== undefined,
			`[${WORDS[i]}→${WORDS[j]}] 候補が返らなかった(sim=Infinity?)`);
		assert.ok(
			Math.abs(got - want) < TOL,
			`[${WORDS[i]}→${WORDS[j]}] sim=${got.toFixed(2)} 期待=${want} (差>${TOL})`);
		checked++;
	}
}
assert.equal(checked, WORDS.length * WORDS.length, "49ペアすべてを検証");
print(`[ok] 49ペア一貫性: 対角0 / 同位置1操作${N} / 位置違い2操作${T} で完全一律`);

// 対称性(sim(a,b)==sim(b,a))も明示的に確認する。
for (let i = 0; i < WORDS.length; i++) {
	for (let j = i + 1; j < WORDS.length; j++) {
		assert.equal(EXPECTED[i][j], EXPECTED[j][i],
			`期待行列が非対称: ${WORDS[i]},${WORDS[j]}`);
	}
}
print("[ok] 行列は対称");

print("編集距離一貫性: 全テスト通過");
