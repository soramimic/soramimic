// MIDI取り込みの元歌詞アライメント(frontend/src/xfAlign.js)のテスト。
// 実行: node tests/xfalign.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { alignLyrics } = await import(
	pathToFileURL(path.join(ROOT, "frontend/src/xfAlign.js")).href);

const print = console.log.bind(console);

const xf = (surface, kana) => ({ surface, kana });

// ---- 1歌詞行が複数の歌唱行に割れるケース(文字単位で切り出す) ----
{
	const { lines, matchedCount } = alignLyrics(
		[xf("沈むように", "シズムヨウニ"), xf("溶けてゆくように", "トケテユクヨウニ")],
		"沈むように溶けてゆくように",
	);
	assert.deepEqual(lines.map((l) => l.text), ["沈むように", "溶けてゆくように"]);
	assert.equal(matchedCount, 2);
	print("[ok] 1歌詞行を歌唱行の境界で分割");
}

// ---- 記号・改行を挟んでも対応づく ----
{
	const { lines } = alignLyrics(
		[xf("さよならだけだった", "サヨナラダケダッタ"), xf("その一言で", "ソノヒトコトデ")],
		"「さよなら」だけだった\nその一言で",
	);
	assert.ok(lines[0].matched && lines[0].text.includes("さよなら」だけだった"), lines[0].text);
	assert.equal(lines[1].text, "その一言で");
	print("[ok] 記号・改行を跨いだ対応づけ");
}

// ---- XF側が読みカナだけでも送り仮名の重なりで対応づく(LCSフォールバック) ----
{
	const { lines } = alignLyrics(
		[xf("とけてゆくように", "トケテユクヨウニ")],
		"溶けてゆくように",
	);
	assert.ok(lines[0].matched, "カナ行が対応づかない");
	assert.ok(lines[0].text.includes("けてゆくように"), lines[0].text);
	print("[ok] 読みカナ行のLCSフォールバック");
}

// ---- 歌われない歌詞行は読み飛ばす ----
{
	const { lines } = alignLyrics(
		[xf("沈むように", "シズムヨウニ"), xf("二人だけの空が", "フタリダケノソラガ")],
		"沈むように\n(このセリフ行は歌われない)\n二人だけの空が",
	);
	assert.deepEqual(lines.map((l) => l.text), ["沈むように", "二人だけの空が"]);
	print("[ok] 歌われない行の読み飛ばし");
}

// ---- 対応づかない歌唱行は読みカナのまま ----
{
	const { lines, matchedCount } = alignLyrics(
		[xf("ラララ", "ラララ"), xf("沈むように", "シズムヨウニ")],
		"沈むように",
	);
	assert.equal(lines[0].text, "ラララ");
	assert.equal(lines[0].matched, false);
	assert.equal(lines[1].text, "沈むように");
	assert.equal(matchedCount, 1);
	print("[ok] 未対応行のカナフォールバック");
}

// ---- 繰り返し(同じ行が2回)は順番に消費する ----
{
	const { lines } = alignLyrics(
		[xf("沈むように", "シズムヨウニ"), xf("沈むように", "シズムヨウニ")],
		"沈むように沈むように",
	);
	assert.deepEqual(lines.map((l) => l.matched), [true, true]);
	print("[ok] 繰り返し行の順次消費");
}

// ---- 表記揺れ(2人/二人)でも区間が隣の行に食い込まない(回帰) ----
// LCSの復元が末尾の「が」を「広が」側に取ると「2人だけの空が広が/る夜に」に割れる
{
	const { lines } = alignLyrics(
		[xf("二人だけの空が", "フタリダケノソラガ"), xf("広がる夜に", "ヒロガルヨルニ")],
		"2人だけの空が広が\nる夜に",
	);
	assert.deepEqual(lines.map((l) => l.text), ["2人だけの空が", "広がる夜に"]);
	print("[ok] 表記揺れ時に最短区間を選ぶ(行の食い込みなし)");
}

// ---- 対応区間が元歌詞の改行をまたいでも1行に潰す(回帰) ----
{
	const { lines } = alignLyrics(
		[xf("広がる夜に", "ヒロガルヨルニ")],
		"広が\nる夜に",
	);
	assert.equal(lines[0].text, "広がる夜に");
	assert.ok(!lines[0].text.includes("\n"), "行内に改行が残っている");
	print("[ok] 区間内の改行の除去");
}

print("元歌詞アライメント: 全テスト通過");
