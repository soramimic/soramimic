// 変換前後のテキスト処理。
import { rubySourceRanges } from "./lib/ruby.js";

export const MAX_PHRASE_LENGTH = 40;

// エンジン内の読みはカタカナで保持するが、コピー時の元歌詞は読みやすい
// ひらがなで出す。長音・記号・英数字などはそのまま残す。
function katakanaToHiragana(text) {
	return (text || "").replace(/[ァ-ヶ]/g, (char) =>
		String.fromCharCode(char.charCodeAt(0) - 0x60));
}

// 発音だけでは「ショー」から元の綴りが「しょう」か「しょお」かを復元できない。
// 元表記に残っているかな（助詞・送り仮名を含む）を優先し、それ以外を発音で補う。
function originalHiragana(word) {
	const yomi = katakanaToHiragana(word.originalkana);
	const surface = katakanaToHiragana(word.original_surface);
	if (!surface) return yomi;
	if (/^[ぁ-ゖー]+$/.test(surface)) return surface;

	const leadingKana = surface.match(/^[ぁ-ゖー]+/)?.[0] || "";
	const trailingKana = surface.match(/[ぁ-ゖー]+$/)?.[0] || "";
	const chars = Array.from(yomi);
	if (leadingKana) chars.splice(0, Array.from(leadingKana).length, ...leadingKana);
	if (trailingKana) {
		chars.splice(Math.max(0, chars.length - Array.from(trailingKana).length),
			Array.from(trailingKana).length, ...trailingKana);
	}
	return chars.join("");
}

// 長い行を区切り文字(改行・句読点・空白)を考慮して分割する
export function splitLongLine(text, max_length) {
	const ranges = rubySourceRanges(text);
	let result = [];
	let start = 0;
	let length = max_length;
	let delimiters = [/\r\n|\n|。/, /\s|、|,/];
	while (start + length < text.length) {
		const crossing = ranges.find((span) => span.start < start + length && start + length < span.end);
		if (crossing) {
			// Prefer cutting before an annotation. An annotation longer than the
			// phrase limit stays intact because its reading cannot be guessed in parts.
			length = (crossing.start > start ? crossing.start : crossing.end) - start;
		}
		if (start + length >= text.length) break;
		for (let d of delimiters) {
			const matches = [...text.substr(start, length).matchAll(new RegExp(d.source, "g"))]
				.filter((match) => !ranges.some((span) =>
					span.start <= start + match.index && start + match.index < span.end));
			if (!matches.length) continue;
			const last = matches.at(-1);
			length = last.index + last[0].length;
			break;
		}
		result.push(text.substr(start, length));
		start = start + length;
		length = max_length;
	}
	result.push(text.substr(start));
	return result;
}

// 入力テキストを変換単位(フレーズ)の配列にする
export function textToPhrases(text) {
	const ranges = rubySourceRanges(text);
	const raw_phrases = [];
	let start = 0;
	for (const match of text.matchAll(/\r\n|\n|\r|\//g)) {
		if (ranges.some((span) => span.start <= match.index && match.index < span.end)) continue;
		raw_phrases.push(text.slice(start, match.index));
		start = match.index + match[0].length;
	}
	raw_phrases.push(text.slice(start));
	return raw_phrases.map((v) => splitLongLine(v, MAX_PHRASE_LENGTH)).flat();
}

// 変換結果を出力形式に整形する
export function makeResultText(result, format) {
	if (format == "1") {
		return result.map((line) => {
			let l1 = line.map((v) => v.surface).join("  ");
			let l2 = line.map((v) => v.original_surface).join("");
			return [l1, l2, ""].join("\n");
		}).join("\n");
	} else if (format == "2") {
		return result.map((line) => {
			let l1 = line.map((v) => v.kana).join("/"); //yomi
			let l2 = line.map((v) => v.originalkana).join("/"); //org
			return [l1, l2, ""].join("\n");
		}).join("\n");
	} else if (format == "3") {
		return result.map((line) => {
			let l1 = line.map((v) => v.original_surface).join("/");
			let l2 = line.map((v) => v.originalkana).join("/");
			let l3 = line.map((v) => v.surface).join("/");
			let l4 = line.map((v) => v.kana).join("/");
			let l5 = line.map((v) => v.original).join("/");
			return [l1, l2, l3, l4, l5, ""].join("\n");
		}).join("\n");
	} else if (format == "4") {
		return result.map((line) => {
			// 同じ区切りを使い、替え歌の各語と元歌詞の読みを対応させる。
			let l1 = line.map((v) => v.surface).join("  ");
			let l2 = line.map(originalHiragana).join("  ");
			return [l1, l2, ""].join("\n");
		}).join("\n");
	}
	return "";
}
