// アプリ初期化の共通部(生成画面 app.js と編集ツール editor.js で共有)。
// データJSONの読み込み・kuromoji初期化・createSoramimic の配線を行う。
// ブラウザ実績のあるプリビルド版を使う(src版はViteバンドルでzlibjsが壊れる)
import kuromoji from "kuromoji/build/kuromoji.js";
import { createSoramimic } from "./lib/index.js";
import { KuromojiTokenizer } from "./lib/kuromojiTokenizer.js";
import { fetchText, fetchJson } from "./api.js";
import { customWordlistId, LEGACY_ORIGINAL_STORAGE_KEY } from "./customWordlists.js";

export const ORIGINAL_STORAGE_KEY = LEGACY_ORIGINAL_STORAGE_KEY;

// 重いリソース(データJSON約5MB + kuromoji辞書約18MB)を並列ロードして
// 生成エンジンを組み立てる。UI側は設定だけで先に起動できるよう分離してある
export async function loadEngine() {
	// 形態素解析はブラウザ内で完結(kuromoji.js)。辞書はビルド時にpublicへコピーされる
	const tokenizerPromise = new Promise((resolve, reject) => {
		kuromoji.builder({ dicPath: "kuromoji/dict" }).build(
			(err, tk) => (err ? reject(err) : resolve(tk)));
	});
	const [
		kanjiDict, englishDict, romanTree,
		vowelSimilarity, consonantSimilarity, kana2phonon,
	] = await Promise.all([
		fetchJson("data/kanjiyomi.json"),
		fetchJson("data/english-kana.json"),
		fetchJson("data/tree_roma2kana.json"),
		fetchJson("data/simVowelsMonoTie.json"),
		fetchJson("data/simConsonantsMonoTie.json"),
		fetchJson("data/kana2phonon.json"),
	]);
	const mecab = KuromojiTokenizer(await tokenizerPromise);
	const inputs = {
		kanjiDict, englishDict, romanTree, kana2phonon,
		tokenizeSentenses: mecab.tokenize,
		getYomi: mecab.getYomi,
	};

	// 類似度行列は monophone(コア音素)タイブレーク方式(#102)。値は
	//   コア音素一致 → 0 / 長短同一母音(a↔a:、母音のみ)→ 20 / 不一致 → 70+ε([70,80])
	// の {0}∪{20}∪[70,80] で、母音も子音も「まず一致個数を最大化、質は同数時の
	// タイブレーク」で意味論が揃う(長短違いは準一致帯。#102 実機診断)。
	// 「音の合わせ方」(vowelRatio = r)は純粋な母音/子音の重み:
	//   libのベース類似度は(子音距離+母音距離)/2 固定だが、入力行列を
	//   母音×2r・子音×2(1-r) に前処理すると (r·母音 + (1-r)·子音) になる。
	//   r=0.8 で「母音ロック・子音タイブレーク」、r=0.2 でその鏡像(子音ロック)。
	//   SAME_VOWEL/CONSONANT_REWARD の掛け算ハックは不要になり、rの一軸で滑らかに動く。
	function scaleMatrix(m, f) {
		const out = {};
		for (const k1 in m) {
			out[k1] = {};
			for (const k2 in m[k1]) out[k1][k2] = m[k1][k2] * f;
		}
		return out;
	}
	const apps = new Map();
	function appFor(vowelRatio = 0.8) {
		const r = Math.min(0.9, Math.max(0.1, Number(vowelRatio) || 0.8));
		const key = r.toFixed(2);
		if (!apps.has(key)) {
			apps.set(key, createSoramimic({
				...inputs,
				vowelSimilarity: scaleMatrix(vowelSimilarity, 2 * r),
				consonantSimilarity: scaleMatrix(consonantSimilarity, 2 * (1 - r)),
			}));
		}
		return apps.get(key);
	}
	return { app: appFor(0.8), appFor, mecab };
}

export async function initSoramimicApp({ vowelRatio = 0.8 } = {}) {
	const [engine, config] = await Promise.all([
		loadEngine(),
		fetchJson("conf/setting.json"),
	]);
	return { app: engine.appFor(vowelRatio), appFor: engine.appFor, mecab: engine.mecab, config };
}

// 単語リスト設定エントリ(conf/setting.json の wordlist 要素)からDBを構築する。
// where を渡すとエントリ既定の entry.where を上書きする(ファセット絞り込み用)。
export async function buildDatabase(app, entry, where) {
	if (customWordlistId(entry.value)) {
		return app.wordList.parsePlain(entry.originalText || "");
	}
	if (entry.value === "ORIGINAL") {
		const text = localStorage.getItem(ORIGINAL_STORAGE_KEY) || "";
		return app.wordList.parsePlain(text);
	}
	const text = await fetchText(entry.filepath);
	return entry.dbtype === "tidy"
		? app.wordList.parseTidy(text, where !== undefined ? where : entry.where)
		: app.wordList.parsePlain(text);
}
