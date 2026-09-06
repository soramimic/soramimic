// 変換前後のテキスト処理。widget/ConversionArea.js から移植(ロジック無改変)。

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
	let result = [];
	let start = 0;
	let length = max_length;
	let delimiters = [/\r\n|\n|。/, /\s|、|,/];
	while (start + length < text.length) {
		for (let d of delimiters) {
			if (d.test(text.substr(start, length)) === false) continue;
			let tmp = text.substr(start, length).split(d);
			let last = tmp[tmp.length - 1].length;
			length = length - last;
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
	const SPLITTER = "/";
	text = text.replace(/\r\n|\n|\r/g, SPLITTER);
	const raw_phrases = text.split(SPLITTER);
	return raw_phrases.map((v) => splitLongLine(v, MAX_PHRASE_LENGTH)).flat();
}

// 変換結果を出力形式に整形する
export function makeResultText(result, format) {
	if (format == "1") {
		return result.map((line) => {
			let l1 = line.map((v) => v.surface).join("  "); //word
			let l2 = line.map((v) => v.original_surface).join(""); //org
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
