// 自作リストの正規化CSV(plainToCsv)の契約テスト。
// 編集ツールは書き出しJSONに「DB構築に使ったtidy CSV」を同梱する(csvText契約)ため、
//   1. 同じテキストからは常に同じCSV(=同じid)が出ること(idの決定性)
//   2. parseTidy(csv, "") が parsePlain(text) と同じDBになること(ラウンドトリップ)
// が壊れると、書き出しJSONの results の id とDBの id がずれる。
// 実行: node tests/wordlist-csv.mjs
import assert from "node:assert";
import { buildApp } from "./golden/harness-lib.mjs";

const h = await buildApp({ tokenizer: "kuromoji" });
const { wordList } = h.app;

const PLAIN = [
	"# コメント行(idを消費しない)",
	"カレーライス,カレー,ライス",
	"",
	"寿司",
	"天ぷら,テンプラ#行末コメント",
].join("\n");

// ---- 1. idの決定性 ----
const csv = wordList.plainToCsv(PLAIN);
assert.strictEqual(csv, wordList.plainToCsv(PLAIN), "同じ入力から同じCSVが出ること");
assert.ok(!csv.endsWith("\n"), "末尾改行なし(パーサが最終空行で落ちるため)");

const rows = csv.split("\n");
assert.strictEqual(rows[0], "id,original,surface,pronunciation", "ヘッダが付くこと");
// idはコメント・空行を落としたあとの行番号(0始まり)。読みが複数あっても同じidを共有する。
// また「見出し語,読み1,読み2…」の1列目は original 兼 surface(表示に使う表記)で、
// 2列目以降は pronunciation(マッチングにだけ使う)
assert.deepStrictEqual(rows.slice(1), [
	"0,カレーライス,カレーライス,カレー",
	"0,カレーライス,カレーライス,ライス",
	"1,寿司,寿司,寿司",
	"2,天ぷら,天ぷら,テンプラ",
], "idの採番が想定と違う:\n" + csv);

// 先頭に行を足すと後続のidがずれる = idはテキスト内容に対して決まる。
// (だからこそ書き出しJSONにはCSVそのものを同梱する必要がある)
const shifted = wordList.plainToCsv("うどん\n" + PLAIN);
assert.ok(shifted.includes("1,カレーライス,カレーライス,カレー"),
	"行を足したらidがずれること(前提の確認):\n" + shifted);

// ---- 2. parseTidy(csv, "") == parsePlain(text) ----
const fromPlain = wordList.parsePlain(PLAIN);
const fromCsv = wordList.parseTidy(csv, "");
assert.deepStrictEqual(fromCsv, fromPlain,
	"CSV経由のDBがplain経由のDBと一致しないと、書き出しJSONのidが合わなくなる");
// 実データが入っていることも確認(空同士の一致でごまかされないように)
assert.ok(Object.keys(fromPlain).length > 0, "DBが空");

// ---- 2.5 読みを書いても表示は見出し語 ----
// 「カレーライス,カレー,ライス」の読みで当たった単語も、チップ・書き出し・字幕には
// 見出し語「カレーライス」が出る(読みはマッチングにだけ使う)
const entries = Object.values(fromPlain).flat();
const curry = entries.filter((e) => e.original === "カレーライス");
assert.ok(curry.length > 0, "カレーライスの項目がDBにない");
assert.deepStrictEqual([...new Set(curry.map((e) => e.surface))], ["カレーライス"],
	"読みがsurfaceになっている(表示が見出し語にならない)");
assert.ok(curry.some((e) => e.kana === "カレー") && curry.some((e) => e.kana === "ライス"),
	"読みがpronunciationとして取り込まれていない: "
		+ [...new Set(curry.map((e) => e.kana))].join(","));

// ---- 3. 空テキスト ----
assert.strictEqual(wordList.plainToCsv(""), "id,original,surface,pronunciation",
	"空テキストでもヘッダだけのCSVになること");

// ハーネスが console.log を黙らせるので直接書き出す
process.stdout.write("[ok] wordlist csv contract\n");
