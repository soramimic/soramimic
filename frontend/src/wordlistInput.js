// 自作リストの入力テキスト(生成画面の登録欄・編集ツール⚙の編集欄。localStorageで共有)を、
// エンジンがそのまま読める tidy CSV へ正規化する前処理層。
//
// 受け付ける書き方は2通り(埋め込み先 soramimic-video の wordlist_csv.py と同じ考え方):
//
// 1. ヘッダ付き tidy CSV — 1行目のセルに既知の列名(id/original/surface/pronunciation)が
//    1つでもあればヘッダとみなし、行の中身は作り直さずに通す。**id はユーザーが書いた値を
//    尊重する**(振り直さない): 書き出しJSONの results の id と、DB側の id が1対1で
//    対応している契約(csvText契約)を壊さないため。
// 2. かんたん形式(plain) — 従来の「見出し語,読み1,読み2…」。lib の plainToCsv に渡す。
//
// 呼び出し側は初期化済みの app(wordList.plainToCsv を持つ)を渡すだけ。

// エンジンが名前で引く列。ヘッダ判定にもこの4つを使う
export const BASE_COLUMNS = ["id", "original", "surface", "pronunciation"];

// 追加列として受け取らない列。画像は自作リスト(エディタ内)では使わないうえ、
// csvText に残すと埋め込み先で外部パスを差し込む口になるので落とす
const DROPPED_COLUMNS = new Set(["image", "image_page"]);

// 列名の揺れ(BOM・前後空白・大文字小文字)だけ均す。エンジンのCSVパーサは列名の
// 完全一致しか見ないので、日本語の別名(表記/読み 等)はここでは受け付けない
function normalizeColumn(name) {
	const cleaned = String(name ?? "").replace(/\uFEFF/g, "").trim();
	return /^[\x20-\x7e]*$/.test(cleaned) ? cleaned.toLowerCase() : cleaned;
}

function cleanCell(value) {
	return String(value ?? "").replace(/\uFEFF/g, "").trim();
}

/**
 * 1行目が tidy CSV のヘッダらしいか。
 *
 * 既知の列名が1つでもあればヘッダとみなす(埋め込み先の `_looks_like_header` と同じ発想)。
 * ただし**セルが1つだけの行はヘッダにしない**: plain の1行目がたまたま「surface」の
 * ような語だったときに、語をヘッダとして食べてしまうのを避けるため。
 * 逆に「id,original,surface,pronunciation」そのものを語として並べた plain は区別できず、
 * ヘッダとして解釈される(埋め込み先も同じ割り切り)。
 */
export function looksLikeTidyHeader(line) {
	const cells = String(line ?? "").split(",").map(normalizeColumn);
	if (cells.length < 2) return false;
	return cells.some((c) => BASE_COLUMNS.includes(c));
}

// 空行を飛ばした最初の行(ヘッダ判定に使う)
function firstContentLine(text) {
	for (const line of String(text ?? "").split(/\r\n|\n|\r/)) {
		if (line.trim() !== "") return line;
	}
	return "";
}

/**
 * ヘッダ付き tidy CSV を、エンジンが読める形に均す。
 *
 * - id は書かれた値をそのまま使う(無い行・無い列のときだけ行番号を振る)
 * - 列の並びは書かれたまま。足りない基本列(id/original/surface/pronunciation)は末尾に足す
 * - image / image_page 列は落とす。同名の列は先に出たほうを採用(エンジンの h2i は後勝ち)
 * - 読みが空(または NA)の行は空のまま通す(エンジンが表記から読みを組む)
 */
export function tidyTextToCsv(text) {
	const rows = String(text ?? "")
		.split(/\r\n|\n|\r/)
		.map((line) => line.split(",").map(cleanCell))
		.filter((cells) => cells.some((c) => c !== ""));
	if (rows.length === 0) return BASE_COLUMNS.join(",");

	const header = rows[0].map(normalizeColumn);
	const keep = []; // [元の列index, 列名]
	const seen = new Set();
	for (let i = 0; i < header.length; i++) {
		const name = header[i];
		if (!name || seen.has(name) || DROPPED_COLUMNS.has(name)) continue;
		seen.add(name);
		keep.push([i, name]);
	}
	if (!seen.has("surface") && !seen.has("original")) {
		throw new Error(
			"単語リストのCSVに surface(表記)の列がありません。"
			+ "1行目の列名に surface を入れてください。見つかった列: "
			+ (header.filter(Boolean).join(", ") || "(なし)"));
	}
	const columns = keep.map(([, name]) => name);
	const added = BASE_COLUMNS.filter((c) => !seen.has(c)); // 末尾に足す欠損列
	const at = (name) => columns.indexOf(name);

	const body = [];
	for (let r = 1; r < rows.length; r++) {
		const row = rows[r];
		const values = keep.map(([i]) => row[i] ?? "");
		const cell = (name) => (at(name) >= 0 ? values[at(name)] : "");
		const surface = cell("surface") || cell("original");
		if (!surface) continue; // 表記のない行(末尾の空行など)は捨てる
		const original = cell("original") || surface;
		// idはユーザーの値を尊重する。書かれていないときだけ行番号を振る
		const id = cell("id") || String(body.length);
		let pronunciation = cell("pronunciation");
		if (pronunciation === "NA" || pronunciation === "na") pronunciation = "";
		const filled = { id, original, surface, pronunciation };
		for (const name of BASE_COLUMNS) {
			if (at(name) >= 0) values[at(name)] = filled[name];
		}
		for (const name of added) values.push(filled[name]);
		body.push(values);
	}
	// 末尾に改行を付けない(エンジンのCSVパーサが最終空行で落ちるため)
	return [columns.concat(added).join(","), ...body.map((v) => v.join(","))].join("\n");
}

/**
 * 自作リストの入力テキスト → DB構築に使う正規化 tidy CSV。
 *
 * app は初期化済みの createSoramimic の返り値(wordList.plainToCsv を使う)。
 * 生成画面・編集ツールの両方でこれを通す。
 */
export function originalTextToCsv(text, app) {
	const src = String(text ?? "");
	const head = firstContentLine(src);
	// 先頭がコメント行のときは plain(列名をコメントで書いた説明行をヘッダと誤認しない)
	if (!head.trim().startsWith("#") && looksLikeTidyHeader(head)) {
		return tidyTextToCsv(src);
	}
	return app.wordList.plainToCsv(src);
}
