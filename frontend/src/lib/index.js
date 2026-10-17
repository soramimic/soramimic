// js/Loader.js と同じ配線。データ(JSON)とトークナイザは呼び出し側から注入する
import { Kanji, Character } from "./character.js";
import { KanaToSyllable } from "./kanaToSyllable.js";
import { English } from "./english.js";
import { TextAnalyzer } from "./textAnalyzer.js";
import { KanaSimilarity } from "./kanaSimilarity.js";
import { SoramimiMaker } from "./soramimic.js";
import { WordList } from "./wordList.js";

// ルビ記法パーサは他レイヤ(video等)からも使えるよう単体で公開する
export { parseRuby, hasRuby } from "./ruby.js";

export function createSoramimic({
	kanjiDict,
	englishDict,
	romanTree,
	vowelSimilarity,
	consonantSimilarity,
	kana2phonon,
	tokenizeSentenses,
	getYomi,
}) {
	const k2s = KanaToSyllable();
	const kanji = Kanji(kanjiDict, k2s);
	const character = Character(kanji);
	const english = English(englishDict, romanTree);
	const textAnalyzer = TextAnalyzer(character, k2s, english, tokenizeSentenses, getYomi);
	const kanaSimilarity = KanaSimilarity(vowelSimilarity, consonantSimilarity, kana2phonon);
	const soramimiMaker = SoramimiMaker(kanaSimilarity, textAnalyzer, kana2phonon);
	const wordList = WordList(textAnalyzer);
	return { textAnalyzer, kanaSimilarity, soramimiMaker, wordList };
}
