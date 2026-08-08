// 自作リストの正規化CSV(plainToCsv)の契約テスト。
// 編集ツールは書き出しJSONに「DB構築に使ったtidy CSV」を同梱する(csvText契約)ため、
//   1. 同じテキストからは常に同じCSV(=同じid)が出ること(idの決定性)
//   2. parseTidy(csv, "") が parsePlain(text) と同じDBになること(ラウンドトリップ)
// が壊れると、書き出しJSONの results の id とDBの id がずれる。
// 実行: node tests/wordlist-csv.mjs
import assert from "node:assert";
import { buildApp } from "./golden/harness-lib.mjs";
import { originalTextToCsv, looksLikeTidyHeader }
	from "../frontend/src/wordlistInput.js";

const h = await buildApp({ tokenizer: "kuromoji" });
const app = h.app;
const { wordList } = app;

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
assert.ok(!csv.endsWith("\n"), "正規化CSVの末尾に改行を付けないこと");

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
assert.deepStrictEqual(wordList.parseTidy(csv + "\n", ""), fromPlain,
	"末尾改行付きCSVを読み込めない");
assert.deepStrictEqual(wordList.parseTidy(csv + "\r\n\r\n", ""), fromPlain,
	"末尾に複数の空行があるCSVを読み込めない");
assert.deepStrictEqual(wordList.parseTidy(
	rows.slice(0, 2).concat(["", ",,,", " \t ", ...rows.slice(2)]).join("\n"), ""), fromPlain,
	"途中に空行があるCSVを読み込めない");
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


// ================================================================
// 自作リストの入力(生成画面の登録テキスト / エディタ⚙の編集欄)の正規化。
// plain だけでなくヘッダ付き tidy CSV も受け、読みの無い語は形態素解析で
// 読みを推定してCSVに焼き込む(frontend/src/wordlistInput.js)
// ================================================================

// 読みを推定できない環境を模したapp(形態素解析が使えない/失敗するケース)。
// このときは従来どおり「表記そのものを読みにする」へフォールバックする
const noYomiApp = {
	wordList,
	textAnalyzer: { getYomi: (v) => (Array.isArray(v) ? v.map(() => "") : "") },
};

// ---- 4. ヘッダ判定 ----
assert.ok(looksLikeTidyHeader("id,original,surface,pronunciation"), "ヘッダを認識しない");
assert.ok(looksLikeTidyHeader("surface,pronunciation"), "部分的なヘッダを認識しない");
assert.ok(looksLikeTidyHeader("SURFACE, Pronunciation"), "大文字・空白入りのヘッダを認識しない");
assert.ok(looksLikeTidyHeader("surface,image,備考"), "既知列が1つでもあればヘッダ");
// セルが1つだけの行はヘッダにしない(plainの1語目が「surface」でも語として扱う)
assert.ok(!looksLikeTidyHeader("surface"), "1セルの行をヘッダと誤認している");
assert.ok(!looksLikeTidyHeader("カレーライス,カレー,ライス"), "plainの行をヘッダと誤認している");
assert.ok(!looksLikeTidyHeader(""), "空行をヘッダと誤認している");
// 「surface」だけの行から始まる plain は、そのまま1語として取り込まれる
assert.ok(originalTextToCsv("surface\nカレー", noYomiApp).includes("0,surface,surface,surface"),
	"1セルの1行目が語として取り込まれていない");
// 列名をコメントで書いた説明行から始まる plain もヘッダにしない
const commented = originalTextToCsv("# id,original,surface,pronunciation\nカレー", noYomiApp);
assert.strictEqual(commented, "id,original,surface,pronunciation\n0,カレー,カレー,カレー",
	"コメント行をヘッダと誤認している:\n" + commented);

// ---- 5. plain: 読みの推定 ----
// 読みを書いていない語(1列だけの行)は、かな以外を含むときだけ推定して2列目に埋める。
// 推定結果はCSVに焼き込むので、再変換・書き出し・埋め込み先の行解決で同じ読みになる
const guessed = originalTextToCsv(["林檎", "すし", "天ぷら,テンプラ"].join("\n"), app);
assert.strictEqual(guessed, [
	"id,original,surface,pronunciation",
	"0,林檎,林檎,リンゴ",   // 漢字→カナを推定して焼き込む
	"1,すし,すし,すし",     // 全部かなの語はそのまま(従来どおり)
	"2,天ぷら,天ぷら,テンプラ", // 読みが書いてある行は触らない
].join("\n"), "読みの推定結果が想定と違う:\n" + guessed);

// 推定が効かない語(記号・英字・未知語)は従来どおり表記そのものを読みにする。
// 英字はエンジン側(formatKana)がカナに直すので、ここで潰してはいけない
const symbols = originalTextToCsv(["★", "Apple"].join("\n"), app);
assert.strictEqual(symbols, [
	"id,original,surface,pronunciation",
	"0,★,★,★",
	"1,Apple,Apple,Apple",
].join("\n"), "推定できない語のフォールバックが想定と違う:\n" + symbols);

// 形態素解析が使えないときは plainToCsv そのままの出力に戻る(idもぶれない)
assert.strictEqual(originalTextToCsv(PLAIN, noYomiApp), wordList.plainToCsv(PLAIN),
	"読みを推定できないときに従来の出力へ戻らない");
// 読みを埋めてもコメント・空行の扱いは変わらない(=idの採番が変わらない)
assert.deepStrictEqual(
	originalTextToCsv(PLAIN, app).split("\n").map((r) => r.split(",")[0]),
	wordList.plainToCsv(PLAIN).split("\n").map((r) => r.split(",")[0]),
	"読みの推定でidの採番が変わっている");

// ---- 6. ヘッダ付き tidy CSV ----
// 列順は不同でよい。idはユーザーが書いた値をそのまま使う(振り直さない)。
// image 列は落とす(csvTextに残すと埋め込み先で外部パスを差し込む口になる)
const TIDY = [
	"surface,image,id,pronunciation",
	"林檎,foo.png,7,",      // 読み空 → 推定して埋める
	"蜜柑,bar.png,9,ミカン", // 書いてある読みは尊重
	"葡萄,,12,NA",          // NA も「読みなし」扱い
].join("\n");
const tidyCsv = originalTextToCsv(TIDY, app);
assert.strictEqual(tidyCsv, [
	"surface,id,pronunciation,original", // image は落とし、欠けている original を末尾に足す
	"林檎,7,リンゴ,林檎",
	"蜜柑,9,ミカン,蜜柑",
	"葡萄,12,ブドウ,葡萄",
].join("\n"), "tidy CSVの正規化が想定と違う:\n" + tidyCsv);
assert.ok(!tidyCsv.includes("foo.png"), "image列が残っている:\n" + tidyCsv);

// idはそのままDBに入る(書き出しJSONの results とのid一致がこれで保たれる)
const tidyDb = wordList.parseTidy(tidyCsv, "");
const tidyIds = [...new Set(Object.values(tidyDb).flat().map((e) => e.id))].sort();
assert.deepStrictEqual(tidyIds, ["12", "7", "9"], "ユーザーの書いたidが尊重されていない: " + tidyIds);

// 推定できないときの tidy は読み空のまま通し、エンジン側の従来動作(表記から読む)に任せる
const tidyNoYomi = originalTextToCsv(TIDY, noYomiApp);
assert.ok(tidyNoYomi.split("\n")[1] === "林檎,7,,林檎",
	"推定できないtidy行のフォールバックが想定と違う:\n" + tidyNoYomi);
assert.ok(Object.values(wordList.parseTidy(tidyNoYomi, "")).flat().length > 0,
	"読み空のtidyからDBが組めない");

// id列が無いCSVは行番号を振る(plainと同じ0始まり)
const noId = originalTextToCsv("original,surface\nリンゴ,林檎", noYomiApp);
assert.strictEqual(noId, "original,surface,id,pronunciation\nリンゴ,林檎,0,",
	"id列の無いCSVの補完が想定と違う:\n" + noId);

// 表記の手がかりが無いCSVは受け付けない(黙って空のDBにしない)
assert.throws(() => originalTextToCsv("id,pronunciation\n1,リンゴ", noYomiApp),
	/surface/, "surface/originalの無いCSVが素通りしている");

// ハーネスが console.log を黙らせるので直接書き出す
process.stdout.write("[ok] wordlist csv contract\n");
