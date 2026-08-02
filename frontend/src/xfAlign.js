// MIDIの歌唱行(XF歌詞の表記)と元歌詞テキストの対応づけ。
// 変換はトークナイザの文節情報でスコアが変わるため、読みカナではなく
// 元歌詞の表記(漢字かな交じり)で変換の入力行を作れると質が上がる。
//
// 対応づけは2通り作って良い方を採る。
//   1. 行対応: 歌唱行を元歌詞の「行」に割り当てる(単調なDP)。元歌詞の改行が
//      歌唱行の切れ目と一致する普通のケースはこちらが当たり、区切りが
//      元歌詞の改行そのものになるので境界がずれない。1歌詞行が複数の歌唱行に
//      割れるときだけ、その行の中を文字単位で分ける。
//   2. 文字走査: 元歌詞を改行を無視した連続テキストとみなして先頭から
//      各歌唱行の区間を切り出す(元歌詞の改行が歌詞の切れ目と無関係な
//      折り返しだったときのため)。
// どちらも「歌唱行が対応テキストにどれだけ含まれるか」で採点して高い方を採用する
// (同点なら元歌詞の改行を尊重する行対応)。

// 比較用の正規化: 空白・記号を除き、カタカナをひらがなに寄せる。
// 除いた文字を飛ばして元テキストへ戻せるよう、正規化後→元のindex表も返す
const STRIP_RE = /[\s、。,.．，!?!?・「」『』()()〜~♪ー―…-]/;
// 長音記号(直前のモーラの母音が続いているだけなので、母音の判定を引き継ぐ)
const PROLONG_RE = /[ー―~〜]/;
// 行を分けるとき、前の行の末尾に付けたままにする記号(開き括弧は次の行へ送る)
const TRAILING_RE = /[\s、。,.．，!?!?…・」』)）〜~♪ー―-]/;

// 母音(長音の判定用)。ひらがなに寄せてから引く
const VOWEL_ROWS = {
	あ: "あかさたなはまやらわがざだばぱぁゃゎ",
	い: "いきしちにひみりぎじぢびぴぃ",
	う: "うくすつぬふむゆるぐずづぶぷゔぅゅ",
	え: "えけせてねへめれげぜでべぺぇ",
	お: "おこそとのほもよろをごぞどぼぽぉょ",
};
const VOWEL_OF = {};
for (const [vowel, chars] of Object.entries(VOWEL_ROWS)) {
	for (const ch of chars) VOWEL_OF[ch] = vowel;
}

// 直前の音の母音を伸ばしただけの母音か(ゆう→ゆー、めえ→めー、けい→けー)。
// XFの歌詞は1音を複数音符で伸ばすと「ユウメハイイマ」のように母音が挿入され、
// 元歌詞の表記(夢は今)と字面が合わなくなるので、長音とみなして落として比べる
function isLongVowel(prevVowel, ch) {
	if (!prevVowel) return false;
	if (ch === "う") return prevVowel === "お" || prevVowel === "う";
	if (ch === "い") return prevVowel === "え" || prevVowel === "い";
	return "あいうえお".includes(ch) && ch === prevVowel;
}

function normalizeWithMap(text) {
	let normalized = "";
	const map = [];
	let prevVowel = "";
	for (let i = 0; i < text.length; i++) {
		const raw = text[i];
		if (STRIP_RE.test(raw)) {
			// 「ー」は直前の母音の続きなので判定を引き継ぐ。空白・句読点は語の切れ目
			// なので切る(「見たあなた」の「あ」を伸ばしと誤判定しないため)
			if (!PROLONG_RE.test(raw)) prevVowel = "";
			continue;
		}
		const code = raw.charCodeAt(0);
		// カタカナ→ひらがな
		const ch = code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : raw;
		if (isLongVowel(prevVowel, ch)) continue;
		normalized += ch;
		map.push(i);
		prevVowel = VOWEL_OF[ch] || "";
	}
	return { normalized, map };
}

// targetとsliceのLCS(最長共通部分列)の長さ・slice側で最後に一致したindex・
// slice側のどの位置が一致したか(matched[j])を返す
function lcs(target, slice) {
	const n = target.length;
	const m = slice.length;
	const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			dp[i][j] = target[i - 1] === slice[j - 1]
				? dp[i - 1][j - 1] + 1
				: Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	// slice側の一致終端: 末尾から辿って最後に文字が採用された位置。
	// スコアが同じならslice側の文字を先に捨てる(=最短・最左の区間を選ぶ)。
	// 例:「二人だけの空が」vs「2人だけの空が広が」で、末尾の「が」を
	// 「広が」側に取ってしまい対応区間が伸びるのを防ぐ
	let i = n;
	let j = m;
	let lastMatch = -1;
	const matched = new Array(m).fill(false);
	while (i > 0 && j > 0) {
		if (dp[i][j] === dp[i][j - 1]) {
			j--;
		} else if (dp[i][j] === dp[i - 1][j]) {
			i--;
		} else {
			if (lastMatch < 0) lastMatch = j - 1;
			matched[j - 1] = true;
			i--;
			j--;
		}
	}
	return { length: dp[n][m], lastMatch, matched };
}

// 歌唱行の正規化テキストがsliceにどれだけ含まれるか(0..1)
function containment(target, slice) {
	if (!target || !slice) return 0;
	return lcs(target, slice).length / target.length;
}

// これ未満の一致率なら「対応なし」としてその行は読みカナのまま(文字走査)
const MATCH_THRESHOLD = 0.6;
// 行対応で「その歌詞行に対応する」とみなす最低の含有率。行対応は前後の行との
// 兼ね合い(単調DP)に支えられるので、文字走査より緩くてよい
const LINE_MATCH_THRESHOLD = 0.35;
// 歌われない歌詞行を読み飛ばすときのペナルティ(1行あたり)
const LINE_SKIP_PENALTY = 0.05;
// 1歌詞行を複数の歌唱行に割るとき、これを下回る一致率の行があれば文字数按分に退避
const SPLIT_MATCH_THRESHOLD = 0.5;

// ---- 1. 行対応 ----

// 各歌唱行に対応する元歌詞行のindex(対応なしはnull)を返す。
// 対応は単調(使う歌詞行のindexは非減少)で、1つの歌詞行を連続する複数の歌唱行が
// 共有するのは許す(長い歌詞行がカラオケ表示で分割されるケース)
function assignLyricLines(xfNorms, lyricNorms) {
	const n = xfNorms.length;
	const m = lyricNorms.length;
	const sim = xfNorms.map((x) => lyricNorms.map((y) => containment(x, y)));

	const NEG = -Infinity;
	// dp[i][j+1] = 歌唱行 0..i-1 を割り当て済みで、最後に使った歌詞行が j
	// (j=-1 はまだ何も使っていない)ときの最大スコア
	const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NEG));
	const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
	dp[0][0] = 0;

	for (let i = 0; i < n; i++) {
		for (let jj = 0; jj <= m; jj++) {
			if (dp[i][jj] === NEG) continue;
			const j = jj - 1;
			// 対応なし
			if (dp[i][jj] > dp[i + 1][jj]) {
				dp[i + 1][jj] = dp[i][jj];
				back[i + 1][jj] = { prev: jj, assigned: null };
			}
			// 歌詞行 k(継続 j または前進 >j)に割り当て
			for (let k = Math.max(j, 0); k < m; k++) {
				if (sim[i][k] < LINE_MATCH_THRESHOLD) continue;
				const skipped = j >= 0 ? Math.max(0, k - j - 1) : k;
				const score = dp[i][jj] + sim[i][k] - LINE_SKIP_PENALTY * skipped;
				if (score > dp[i + 1][k + 1]) {
					dp[i + 1][k + 1] = score;
					back[i + 1][k + 1] = { prev: jj, assigned: k };
				}
			}
		}
	}

	let bestJJ = 0;
	for (let jj = 1; jj <= m; jj++) if (dp[n][jj] > dp[n][bestJJ]) bestJJ = jj;
	const assignments = new Array(n).fill(null);
	let jj = bestJJ;
	for (let i = n; i > 0; i--) {
		const step = back[i][jj];
		if (!step) break;
		assignments[i - 1] = step.assigned;
		jj = step.prev;
	}
	return assignments;
}

// 前後の対応から、残った歌詞行と対応なしの歌唱行が同数で埋まる隙間を1:1で埋める。
// 漢字ばかりの行(「夕焼小焼の 赤とんぼ」対「ユウヤケコヤケエノ…」)は字面が
// 重ならず類似度で拾えないが、前後が対応づいていて候補が1つに絞れるなら
// その行しかありえない。全体の過半数が対応づいているときだけ働かせる
function fillAssignmentGaps(assignments, xfNorms, m) {
	const n = assignments.length;
	const used = new Set(assignments.filter((a) => a !== null));
	if (used.size * 2 < n) return;
	for (let i = 0; i < n;) {
		if (assignments[i] !== null) { i++; continue; }
		let j = i;
		while (j < n && assignments[j] === null) j++;
		const lo = i > 0 ? assignments[i - 1] + 1 : 0;
		const hi = j < n ? assignments[j] : m;
		const free = [];
		for (let k = lo; k < hi; k++) if (!used.has(k)) free.push(k);
		// 空の歌唱行(テキストを持たない行)には割り当てない
		const hasText = xfNorms.slice(i, j).every(Boolean);
		if (free.length === j - i && hasText) {
			free.forEach((k, p) => { assignments[i + p] = k; used.add(k); });
		}
		i = j;
	}
}

// 歌唱行の正規化テキスト列で1つの歌詞行を分ける(正規化座標の切れ目を返す)。
// 一致が弱ければ null(呼び出し側が按分に退避する)
function splitPoints(xfNorms, normalized) {
	const n = xfNorms.length;
	const cuts = [0];
	let cursor = 0;
	for (let i = 0; i < n - 1; i++) {
		const target = xfNorms[i];
		if (!target) return null;
		let end = -1;
		const at = normalized.indexOf(target, cursor);
		if (at >= 0) {
			end = at + target.length;
		} else {
			let best = { score: 0, end: -1 };
			for (let s = cursor; s < normalized.length; s++) {
				const { length, lastMatch } = lcs(target, normalized.slice(s, s + target.length + 2));
				if (length > best.score) best = { score: length, end: s + lastMatch + 1 };
				if (length === target.length) break; // これ以上は良くならない
			}
			if (best.score / target.length >= SPLIT_MATCH_THRESHOLD) end = best.end;
		}
		// 単調に進み、残りの歌唱行ぶんの文字を必ず1文字以上残す
		if (end <= cuts[i] || end > normalized.length - (n - 1 - i)) return null;
		cuts.push(end);
		cursor = end;
	}
	cuts.push(normalized.length);
	return cuts;
}

// 文字数比で切れ目を作る(splitPointsが使えないときの退避)
function proportionalPoints(xfNorms, length) {
	const n = xfNorms.length;
	const weights = xfNorms.map((x) => Math.max(1, x.length));
	const total = weights.reduce((a, b) => a + b, 0);
	const cuts = [0];
	let acc = 0;
	for (let i = 0; i < n - 1; i++) {
		acc += weights[i];
		// 直前の切れ目より必ず1文字は進め、後続の行ぶんの文字を残す
		const pos = Math.round((length * acc) / total);
		cuts.push(Math.max(cuts[i] + 1, Math.min(pos, length - (n - 1 - i))));
	}
	cuts.push(length);
	return cuts;
}

function slicePieces(lyricLine, bounds) {
	return bounds.slice(0, -1).map((s, i) => {
		const piece = lyricLine.slice(s, bounds[i + 1]);
		return piece.trim() || piece;
	});
}

// 1つの歌詞行を、それに割り当てられた歌唱行の数だけの部分文字列に分ける。
// 連結すると(前後の空白を除き)元の行に戻る。分ける文字が足りないときだけ
// 空文字を返す(その行は対応なし=読みカナのままになる)
function splitLyricLine(xfNorms, lyricLine) {
	const n = xfNorms.length;
	if (n === 1) return [lyricLine];
	if (lyricLine.length < n) return [lyricLine, ...new Array(n - 1).fill("")];
	const { normalized, map } = normalizeWithMap(lyricLine);
	if (normalized.length < n) {
		return slicePieces(lyricLine, proportionalPoints(xfNorms, lyricLine.length));
	}
	const cuts = splitPoints(xfNorms, normalized) || proportionalPoints(xfNorms, normalized.length);
	// 正規化座標の切れ目を元テキストの位置へ戻す。前の行の最後の文字の直後を境界に
	// し、そこから続く記号だけ前の行に含める(正規化で落とした文字が次の行の頭に
	// 食い込まないよう、map[c] ではなく map[c-1]+1 から始める)
	const bounds = cuts.map((c, i) => {
		if (i === 0) return 0;
		if (i === cuts.length - 1 || c > map.length - 1) return lyricLine.length;
		let pos = map[c - 1] + 1;
		while (pos < lyricLine.length && TRAILING_RE.test(lyricLine[pos])) pos++;
		return pos;
	});
	return slicePieces(lyricLine, bounds);
}

function alignByLyricLines(xfLines, xfNorms, lyricLines) {
	if (lyricLines.length === 0) return null;
	const lyricNorms = lyricLines.map((s) => normalizeWithMap(s).normalized);
	const assignments = assignLyricLines(xfNorms, lyricNorms);
	fillAssignmentGaps(assignments, xfNorms, lyricLines.length);

	const texts = new Array(xfLines.length).fill(null);
	// 同じ歌詞行に付いた歌唱行(間に対応なしの行を挟むこともある)でその行を分ける
	for (let k = 0; k < lyricLines.length; k++) {
		const idxs = [];
		assignments.forEach((a, i) => { if (a === k) idxs.push(i); });
		if (idxs.length === 0) continue;
		const pieces = splitLyricLine(idxs.map((i) => xfNorms[i]), lyricLines[k]);
		idxs.forEach((i, p) => { texts[i] = pieces[p]; });
	}
	return texts.map((text, i) => (text
		? { text, matched: true }
		: { text: xfLines[i].kana, matched: false }));
}

// ---- 2. 文字走査 ----

function alignByScan(xfLines, xfNorms, lyricsText) {
	const { normalized, map } = normalizeWithMap(lyricsText);
	let cursor = 0;
	return xfLines.map((line, i) => {
		const target = xfNorms[i];
		if (!target) return { text: line.kana, matched: false };

		// まず完全一致(歌われない行を挟んでいても飛ばせる)
		let start = normalized.indexOf(target, cursor);
		let end = start >= 0 ? start + target.length : -1;

		if (start < 0) {
			// 揺れ(読み表記・脱字など)はLCSでその近傍から探す
			const window = Math.max(40, target.length * 3);
			let best = { score: 0, start: -1, end: -1 };
			const searchEnd = Math.min(normalized.length, cursor + window);
			for (let s = cursor; s <= searchEnd - 1; s++) {
				const slice = normalized.slice(s, s + target.length + 2);
				if (!slice) break;
				const { length, lastMatch } = lcs(target, slice);
				if (length > best.score) {
					best = { score: length, start: s, end: s + lastMatch + 1 };
				}
				if (length === target.length) break; // これ以上は良くならない
			}
			if (best.score / target.length >= MATCH_THRESHOLD) {
				start = best.start;
				end = best.end;
			}
		}

		if (start < 0) return { text: line.kana, matched: false };
		cursor = end;
		// 正規化で除いた記号は、対応区間の内側にあるものだけ含めて戻す。
		// ただし区間が元歌詞の改行をまたぐことがあるため、改行類は1行に潰す
		const origStart = map[start];
		const origEnd = map[end - 1] + 1;
		const text = lyricsText.slice(origStart, origEnd).replace(/\s*[\r\n]\s*/g, "");
		return { text, matched: true };
	});
}

// ---- 採点と選択 ----

// 正規化後のかな(比較で「歌われていれば一致するはず」の文字)
const KANA_RE = /[ぁ-ゖ]/;

// 対応づけの良さ。歌唱行と一致した文字を足し、対応テキストに余った「かな」を引く。
// 余りを引くのは、歌詞行の一部しか歌われていないとき(「私は沈むけど、とけない」の
// うち「沈む」「とけ」だけ歌う)に行まるごとを持ってこないため。漢字は読みと
// 字面が違って当然なので、余っていても数えない
function scoreAlignment(xfNorms, lines) {
	let score = 0;
	let total = 0;
	xfNorms.forEach((target, i) => {
		total += target.length;
		if (!target || !lines[i].matched) return;
		const text = normalizeWithMap(lines[i].text).normalized;
		const { length, matched } = lcs(target, text);
		const extra = [...text].filter((ch, j) => !matched[j] && KANA_RE.test(ch)).length;
		score += length - extra;
	});
	return total === 0 ? 0 : score / total;
}

// xfLines: parseXfMidiの結果({surface, kana}の配列) / lyricsText: 元歌詞
// 戻り値: { lines: [{ text, matched }], matchedCount, snappedCount }
// snappedCount は元歌詞の1行をまるごと採用できた行数。matchedCount より少なければ
// 「元歌詞の改行と歌唱行の切れ目がずれていて、区切りを推定した行がある」の意
export function alignLyrics(xfLines, lyricsText) {
	const xfNorms = xfLines.map((l) => normalizeWithMap(l.surface || l.kana).normalized);
	const lyricLines = lyricsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	const byLine = alignByLyricLines(xfLines, xfNorms, lyricLines);
	const byScan = alignByScan(xfLines, xfNorms, lyricsText);
	// 同点なら元歌詞の改行を尊重する行対応を採る
	const lines = byLine && scoreAlignment(xfNorms, byLine) >= scoreAlignment(xfNorms, byScan)
		? byLine
		: byScan;

	const wholeLines = new Set(lyricLines);
	let matchedCount = 0;
	let snappedCount = 0;
	for (const line of lines) {
		if (!line.matched) continue;
		matchedCount++;
		if (wholeLines.has(line.text.trim())) snappedCount++;
	}
	return { lines, matchedCount, snappedCount };
}

// 行のテキスト配列(編集ツールの phrases など、MIDIの行オブジェクトを持たない側)から
// 同じ対応づけを使うための薄いラッパ。
// 戻り値: { originalLines, matchedCount, snappedCount }。originalLines は lines と
// 同じ長さで、対応づかなかった行は空文字(呼び出し側が「対応なし」を判別できるように
// する。alignLyrics 本体は未対応行に読みカナを入れて返すが、字幕用途では
// 読みカナを元歌詞として出したくないため)
export function alignLyricsToLines(lines, lyricsText) {
	const { lines: aligned, matchedCount, snappedCount } = alignLyrics(
		lines.map((text) => ({ surface: String(text ?? ""), kana: "" })), lyricsText);
	return {
		originalLines: aligned.map((l) => (l.matched ? l.text : "")),
		matchedCount,
		snappedCount,
	};
}
