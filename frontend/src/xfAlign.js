// MIDIの歌唱行(XF歌詞の表記)と元歌詞テキストの対応づけ。
// 変換はトークナイザの文節情報でスコアが変わるため、読みカナではなく
// 元歌詞の表記(漢字かな交じり)で変換の入力行を作れると質が上がる。
//
// 元歌詞は改行位置がXFの歌唱行と一致するとは限らない(1歌詞行が複数の
// 歌唱行に割れる・歌われない行がある)ので、行ではなく文字単位で
// 「先頭から順に、各歌唱行に対応する元歌詞の区間」を探して切り出す。

// 比較用の正規化: 空白・記号を除き、カタカナをひらがなに寄せる。
// 除いた文字を飛ばして元テキストへ戻せるよう、正規化後→元のindex表も返す
const STRIP_RE = /[\s、。,.．，!?!?・「」『』()()〜~♪ー―…-]/;

function normalizeWithMap(text) {
	let normalized = "";
	const map = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (STRIP_RE.test(ch)) continue;
		const code = ch.charCodeAt(0);
		// カタカナ→ひらがな
		normalized += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
		map.push(i);
	}
	return { normalized, map };
}

// targetとsliceのLCS(最長共通部分列)の長さと、slice側で最後に一致したindexを返す
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
	while (i > 0 && j > 0) {
		if (dp[i][j] === dp[i][j - 1]) {
			j--;
		} else if (dp[i][j] === dp[i - 1][j]) {
			i--;
		} else {
			if (lastMatch < 0) lastMatch = j - 1;
			i--;
			j--;
		}
	}
	return { length: dp[n][m], lastMatch };
}

// これ未満の一致率なら「対応なし」としてその行は読みカナのまま
const MATCH_THRESHOLD = 0.6;

// xfLines: parseXfMidiの結果({surface, kana}の配列) / lyricsText: 元歌詞
// 戻り値: { lines: [{ text, matched }], matchedCount }
export function alignLyrics(xfLines, lyricsText) {
	const { normalized, map } = normalizeWithMap(lyricsText);
	let cursor = 0;
	let matchedCount = 0;
	const lines = xfLines.map((line) => {
		const target = normalizeWithMap(line.surface || line.kana).normalized;
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
		matchedCount++;
		// 正規化で除いた記号は、対応区間の内側にあるものだけ含めて戻す。
		// ただし区間が元歌詞の改行をまたぐことがあるため、改行類は1行に潰す
		const origStart = map[start];
		const origEnd = map[end - 1] + 1;
		const text = lyricsText.slice(origStart, origEnd).replace(/\s*[\r\n]\s*/g, "");
		return { text, matched: true };
	});
	return { lines, matchedCount };
}

// 行のテキスト配列(編集ツールの phrases など、MIDIの行オブジェクトを持たない側)から
// 同じ対応づけを使うための薄いラッパ。
// 戻り値: { originalLines, matchedCount }。originalLines は lines と同じ長さで、
// 対応づかなかった行は空文字(呼び出し側が「対応なし」を判別できるようにする。
// alignLyrics 本体は未対応行に読みカナを入れて返すが、字幕用途では
// 読みカナを元歌詞として出したくないため)
export function alignLyricsToLines(lines, lyricsText) {
	const { lines: aligned, matchedCount } = alignLyrics(
		lines.map((text) => ({ surface: String(text ?? ""), kana: "" })), lyricsText);
	return {
		originalLines: aligned.map((l) => (l.matched ? l.text : "")),
		matchedCount,
	};
}
