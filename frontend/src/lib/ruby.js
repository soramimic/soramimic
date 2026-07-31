// 青空文庫ルビ記法(｜表層《よみ》)のパーサ。
//
// 記法入りテキストを「素テキスト + 区間注釈」に分解するだけの前処理層で、
// 類似度計算やDPには一切関与しない。注釈区間の読みは textAnalyzer 側で
// トークンの pronunciation として強制される。
//
// 記法(v1は明示形のみ):
//   ｜表層《よみ》   … 表層の読みを「よみ」に強制する
//   開始記号は ｜(U+FF5C) と |(U+007C) の両方を受理、読み括弧は 《》 のみ
// エスケープ(でんでんマークダウン流):
//   \｜ \| \《 \》 \\ は文字そのもの。それ以外の文字の前の \ はそのまま文字
// 寛容規則:
//   - 《よみ》が続かない ｜ は通常文字
//   - ｜を伴わない 《…》 は通常文字(暗黙形は未対応)
//   - 表層が空・読みが空の記法は無効(全体を通常文字扱い)
//   - ｜a｜b《ヨミ》 はネスト不可。後ろの ｜ が有効になり、前の ｜ は通常文字
//   - 改行をまたぐ記法は無効
import { hiraToKata } from "./kanaToSyllable.js";

const BARS = new Set(["｜", "|"]);
const OPEN = "《";
const CLOSE = "》";
// バックスラッシュでエスケープできる文字
const ESCAPABLE = new Set(["｜", "|", "《", "》", "\\"]);

// テキストをコードポイント単位の「アトム」列にする。
// エスケープはこの段階で解決し、記法文字ではなく通常文字(char)にする
function toAtoms(text) {
	const atoms = [];
	const chars = Array.from(text);
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i];
		if (c === "\\") {
			const next = chars[i + 1];
			if (next !== undefined && ESCAPABLE.has(next)) {
				atoms.push({ kind: "char", ch: next });
				i++;
				continue;
			}
			// エスケープ対象外(や行末)の \ はそのまま文字
			atoms.push({ kind: "char", ch: "\\" });
			continue;
		}
		if (BARS.has(c)) atoms.push({ kind: "bar", ch: c });
		else if (c === OPEN) atoms.push({ kind: "open", ch: c });
		else if (c === CLOSE) atoms.push({ kind: "close", ch: c });
		else atoms.push({ kind: "char", ch: c });
	}
	return atoms;
}

function isNewline(ch) {
	return ch === "\n" || ch === "\r";
}

// atoms[i] の bar から始まる区間が有効な記法かを調べる。
// 表層・読みはともに「通常文字が1個以上・改行を含まない」ことが条件。
// 表層の途中に別の bar や 《 が現れた時点で無効(=この bar は通常文字)になるため、
// ｜a｜b《ヨミ》 は自動的に後ろの ｜ が勝つ
function matchRuby(atoms, i) {
	let j = i + 1;
	const surface = [];
	while (j < atoms.length && atoms[j].kind === "char" && !isNewline(atoms[j].ch)) {
		surface.push(atoms[j].ch);
		j++;
	}
	if (surface.length === 0) return null;
	if (j >= atoms.length || atoms[j].kind !== "open") return null;
	j++;
	const reading = [];
	while (j < atoms.length && atoms[j].kind === "char" && !isNewline(atoms[j].ch)) {
		reading.push(atoms[j].ch);
		j++;
	}
	if (reading.length === 0) return null;
	if (j >= atoms.length || atoms[j].kind !== "close") return null;
	return { surface, reading, next: j + 1 };
}

// 記法入りテキスト → { plain, annotations }
//   plain: 記法・エスケープを解決した素テキスト
//   annotations: [{start, end, reading}] (start/endはplain上のコードポイントオフセット、endは排他)
//     reading はひらがなをカタカナに正規化して格納する
export function parseRuby(text) {
	const atoms = toAtoms(typeof text === "string" ? text : String(text ?? ""));
	const plain = [];
	const annotations = [];
	let i = 0;
	while (i < atoms.length) {
		const atom = atoms[i];
		if (atom.kind === "bar") {
			const m = matchRuby(atoms, i);
			if (m) {
				const start = plain.length;
				for (const ch of m.surface) plain.push(ch);
				annotations.push({
					start,
					end: plain.length,
					reading: hiraToKata(m.reading.join("")),
				});
				i = m.next;
				continue;
			}
		}
		plain.push(atom.ch);
		i++;
	}
	return { plain: plain.join(""), annotations };
}

// 有効な記法を含むか
export function hasRuby(text) {
	return parseRuby(text).annotations.length > 0;
}
