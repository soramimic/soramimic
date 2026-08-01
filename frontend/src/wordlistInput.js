// 自作リストの入力テキスト(生成画面の登録欄・編集ツール⚙の編集欄。localStorageで共有)を、
// エンジンがそのまま読める tidy CSV へ正規化する前処理層。
//
// 受け付ける書き方は2通り(埋め込み先 soramimic-video の wordlist_csv.py と同じ考え方):
//
// 1. ヘッダ付き tidy CSV — 1行目のセルに既知の列名(id/original/surface/pronunciation)が
//    1つでもあればヘッダとみなし、行の中身は作り直さずに通す。**id はユーザーが書いた値を
//    尊重する**(振り直さない): 書き出しJSONの results の id と、DB側の id が1対1で
//    対応している契約(csvText契約)を壊さないため。
// 2. かんたん形式(plain) — 従来の「見出し語,読み1,読み2…」。1列だけ(=読みが書かれていない)
//    の行は、かな以外を含むときだけ形態素解析(kuromoji)で読みを推定して2列目に埋めてから
//    lib の plainToCsv に渡す。
//
// 読みの推定結果はCSVに焼き込む。こうしておくと、再変換・書き出しJSON・埋め込み先の行解決の
// どこから見ても同じ読みになる(エンジンは読み欄が漢字のときも内部で推定するが、その結果は
// CSVに残らないので、csvText を見る側とズレる)。
//
// lib/ の plainToCsv は同期の純関数のまま触らない方針なので、推定はここでやる。
// 呼び出し側は初期化済みの app(textAnalyzer.getYomi と wordList.plainToCsv を持つ)を渡すだけ。

// エンジンが名前で引く列。ヘッダ判定にもこの4つを使う
export const BASE_COLUMNS = ["id", "original", "surface", "pronunciation"];

// 追加列として受け取らない列。画像は自作リスト(エディタ内)では使わないうえ、
// csvText に残すと埋め込み先で外部パスを差し込む口になるので落とす
const DROPPED_COLUMNS = new Set(["image", "image_page"]);

// 読みとして通すのはカナ(ひらがな/カタカナ)と長音・繰り返し記号だけ
const KANA_ONLY = /^[ぁ-ゖァ-ヺーゝゞヽヾ]+$/;

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
 * 表記の並びから読みを推定する。返すのは「推定できたものだけ」の Map。
 *
 * 推定に失敗した語(記号・英字・未知語)は結果がカナにならないので入れない。
 * 呼び出し側は Map に無い語を従来どおり(表記そのものを読みとして)扱う。
 */
function estimateReadings(words, getYomi) {
	const out = new Map();
	const targets = [...new Set(words.filter((w) => w && !KANA_ONLY.test(w)))];
	if (targets.length === 0 || typeof getYomi !== "function") return out;
	let yomi;
	try {
		yomi = getYomi(targets); // 配列を渡すと配列で返る(KuromojiTokenizer)
	} catch (err) {
		console.warn("読みの推定に失敗しました(表記をそのまま使います):", err);
		return out;
	}
	if (!Array.isArray(yomi)) return out;
	for (let i = 0; i < targets.length; i++) {
		const kana = cleanCell(yomi[i]);
		if (KANA_ONLY.test(kana)) out.set(targets[i], kana);
	}
	return out;
}

/**
 * plain形式のテキストのうち「読みの列が無い行」に、推定した読みを2列目として書き足す。
 *
 * 行数・行の並びは変えない(plainToCsv は「コメント・空行を落としたあとの行番号」を
 * id にするので、行を足し引きすると id がずれる)。
 */
export function fillPlainReadings(text, getYomi) {
	const lines = String(text ?? "").split(/\r\n|\n|\r/);
	// plainToCsv と同じ前処理(#以降はコメント、​ は除去)で「語だけの行」を見つける
	const words = lines.map((line) => {
		const cells = line.replace(/#.*$/, "").replace(/\u200B/g, "").split(",");
		return cells.length === 1 ? cells[0].trim() : "";
	});
	const readings = estimateReadings(words, getYomi);
	return lines
		.map((line, i) => {
			const word = words[i];
			const kana = word ? readings.get(word) : undefined;
			return kana ? `${word},${kana}` : line;
		})
		.join("\n");
}

/**
 * ヘッダ付き tidy CSV を、エンジンが読める形に均す。
 *
 * - id は書かれた値をそのまま使う(無い行・無い列のときだけ行番号を振る)
 * - 列の並びは書かれたまま。足りない基本列(id/original/surface/pronunciation)は末尾に足す
 * - image / image_page 列は落とす。同名の列は先に出たほうを採用(エンジンの h2i は後勝ち)
 * - 読みが空(または NA)の行は表記から読みを推定して埋める
 */
export function tidyTextToCsv(text, getYomi) {
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
	const pending = []; // 読みを推定する行 [values, surface]
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
		if (!pronunciation) pending.push([values, surface]);
		body.push(values);
	}

	if (pending.length > 0) {
		const cols = columns.concat(added);
		const pAt = cols.indexOf("pronunciation");
		const readings = estimateReadings(pending.map(([, s]) => s), getYomi);
		for (const [values, surface] of pending) {
			const kana = readings.get(surface);
			// 推定できない語は空のまま。エンジンが表記から読みを組む従来動作に任せる
			if (kana) values[pAt] = kana;
		}
	}
	// 末尾に改行を付けない(エンジンのCSVパーサが最終空行で落ちるため)
	return [columns.concat(added).join(","), ...body.map((v) => v.join(","))].join("\n");
}

/**
 * 自作リストの入力テキスト → DB構築に使う正規化 tidy CSV。
 *
 * app は初期化済みの createSoramimic の返り値(wordList.plainToCsv と
 * textAnalyzer.getYomi を使う)。生成画面・編集ツールの両方でこれを通す。
 */
export function originalTextToCsv(text, app) {
	const src = String(text ?? "");
	const getYomi = app && app.textAnalyzer ? app.textAnalyzer.getYomi : undefined;
	const head = firstContentLine(src);
	// 先頭がコメント行のときは plain(列名をコメントで書いた説明行をヘッダと誤認しない)
	if (!head.trim().startsWith("#") && looksLikeTidyHeader(head)) {
		return tidyTextToCsv(src, getYomi);
	}
	return app.wordList.plainToCsv(fillPlainReadings(src, getYomi));
}
