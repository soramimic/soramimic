// js/KanaSimilarity.js から移植(ロジック無改変、ESモジュール化のみ)
import { createKanaConverter } from "./kanaToSyllable.js";

function KanaSimilarity(VOWEL_SIMILARITY_, CONSONANT_SIMILARITY_, KANA2PHONON){
	const KanaConverter = createKanaConverter(KANA2PHONON);
	
	//kanaの距離を計算の元を出力する関数
	const KANA_SIMILARITY_BASE_ = (()=>{
		const sims = [CONSONANT_SIMILARITY_, VOWEL_SIMILARITY_]
		const k2p = structuredClone(KANA2PHONON);

		//伸ばし棒を追加
		for(let k1 of Object.keys(k2p)){
		//for(let k1 of k2plist){
			const hasVowel = ("aiueo".includes(k2p[k1][1].slice(-1)));
			//console.log(k1,hasVowel);
			if(hasVowel == true){
				k2p[k1+"ー"] = [k2p[k1][0],k2p[k1][1]+":"];
				//k2p[k1+"ン"] = [k2p[k1][0],k2p[k1][1]+":"];//ンはーと同じ
				//k2p[k1+"ッ"] = k2p[k1];//ッは、なにもないのと同じ
			}
		}
		let k2plist = Object.keys(k2p);
		//return Object.keys(k2p)
		return k2plist
			.reduce( (prev1,k1) => {
				const p1 = k2p[k1];//k1のphonon
				//prev1[k1] = Object.keys(k2p)
				prev1[k1] = k2plist
							.reduce( (prev2,k2) => {
								const p2 = k2p[k2];//k2のphonon
								//if(Object.keys(sims[1]).indexOf(p1[1])<0)
								if(!(p1[1] in sims[1]))
									console.log("k1,p1",k1,p1);
								prev2[k2] = (sims[0][p1[0]][p2[0]]+sims[1][p1[1]][p2[1]])/2;//子音同士、母音同士の類似度の平均をk1とk2の類似度のベースとして定義
								return prev2;
							},{});
				return prev1;
			},{});
	})();
	//console.log(KANA_SIMILARITY_BASE_);
	////parametersに存在しないkeyをthis.DEFAULT_PARAMETER_VALUESを埋めて返す
	const assignDefaultParameter = (parameters) => {
		const DEFAULT_PARAMETER_VALUES_ = {
				SAME_PHRASE_BREAK_REWARD: 1,//文節が一致しているとき掛け算する
				SAME_KANA_REWARD: 1,//同じカナに対して掛け算する
				SAME_VOWEL_REWARD: 1,//同じ母音に対して掛け算する
				SAME_CONSONANT_REWARD: 1,//同じ子音に対して掛け算する
				SAME_BAR_REWARD: 1, //拗音同士に対して掛け算する
				SAME_HATSUON_REWARD: 1, //撥音同士に対して掛け算する(pronunciationではない)
				SAME_SOKUON_REWARD: 1,//促音同士に対して掛け算する
		}
		return Object.assign(DEFAULT_PARAMETER_VALUES_,parameters);
	}

	//パラメータに基づいて微調整する
	const getKanaSimilarity = (parameters = {}) => {
		const param = assignDefaultParameter(parameters);
			//ksb = $.extend(true,{},kanaSimilarityBase)//値渡し
		const ksb = KANA_SIMILARITY_BASE_;
		const ksbKeys = Object.keys(ksb);

		const kanaSimilarity = ksbKeys.reduce((prev1,k1)=>{
			prev1[k1] = ksbKeys.reduce((prev2,k2) => {
				let s = ksb[k1][k2];//baseのsimilarityを取得
				if(KanaConverter.isSameKana(k1,k2)) s *= param.SAME_KANA_REWARD;
				if(KanaConverter.isSameVowel(k1,k2)) s*= param.SAME_VOWEL_REWARD;
				if(KanaConverter.isSameConsonant(k1,k2)) s*= param.SAME_CONSONANT_REWARD;
				if(KanaConverter.isSameHatsuon(k1,k2)) s*= param.SAME_HATSUON_REWARD;
				if(KanaConverter.isSameSokuon(k1,k2)) s*= param.SAME_SOKUON_REWARD;
				prev2[k2] = s;
				return prev2;
			},{});
			return prev1;
		},{});
		console.log("getKanaSimilarity",parameters,param,kanaSimilarity);
		//console.log('get kana similarity',kanaSimilarity);
		return kanaSimilarity;
	}

	let KANA_SIMILARITY_ = null;
	const setKanaSimilarity = (param = {}) => {
		console.log("set param:",JSON.stringify(param));
		KANA_SIMILARITY_ = getKanaSimilarity(param);
	}

	return {
		get: ()=>KANA_SIMILARITY_,
		setKanaSimilarity: setKanaSimilarity,
		getKanaSimilarity: getKanaSimilarity
	}
}
export { KanaSimilarity };
