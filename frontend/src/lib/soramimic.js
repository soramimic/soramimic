// js/soramimic.js から移植(ロジック無改変、ESモジュール化のみ)
import { zip } from "./utils.js";

/*
======================================================================
Project Name    : Soramimic
File Name       : soramimic.js
Encoding        : utf-8
Creation Date   : 2019/08/19
 
Copyright © 2019 Jiro Shimaya. All rights reserved.
======================================================================

 */



//DPに常設する「filler(万能候補)」1ユニットあたりのコスト(#128)。
//fillerは「その位置の元歌詞のかなをそのまま置く」仮想語で、単語が足りない・
//どの単語も合わない区間を必ず埋められる。実単語が1つでも置けるなら必ず負ける
//だけの巨大な有限値にすることで、単語が足りている行の結果は従来と完全に同一になる。
//
//値の根拠(実単語の1行あたり総コストの上限):
//  ・ユニット距離: 類似度行列の最大値は80(母音×2r・子音×2(1-r)にスケールしても
//    ベースの (子音+母音)/2 の最大は80のまま)。重みは行内で平均1に正規化される
//    =総和がユニット数なので、行全体でも 80×ユニット数 を超えない
//  ・VARIATION_COST(既定16・UI最大18)×変種操作数
//  ・WORD_NUMBER_PENALTY(UI最大60)・MID_PHRASE_BREAK_PENALTY(UI最大160)×単語数
//1行は最長40文字(convert.js の MAX_PHRASE_LENGTH)なのでユニット数も40程度で、
//上記を全部足しても1万台に収まる。1e6 はその2桁上なので「fillerを1つ減らせる
//経路は必ず安い」が成り立ち、かつ 1e6×ユニット数 でも倍精度の整数精度(2^53)には
//遠く届かないため、スコアの丸めで順序が壊れることもない
const FILLER_COST = 1e6;
const DEFAULT_APPROXIMATE_CANDIDATES = 512;

const SoramimiMaker = (kanaSimilarity, textAnalyzer, kana2phonon={})=>{
	//近似候補検索用の署名。正確距離は位置ごとの母音・子音距離を浮動小数点で
	//足すが、粗検索では各ユニットを「母音code + 子音code」の1文字に圧縮し、
	//一致/不一致だけを数える。拗音・長音はkana2phononから取ることで
	//「ピョー」の母音を誤って小書きョとして扱わないようにする。
	const vowelCodes = new Map();
	const consonantCodes = new Map();
	const unitFeatureCache = new Map();
	const signatureCache = new WeakMap();
	const featureCode = (map, value) => {
		if(!map.has(value))map.set(value,map.size);
		return map.get(value);
	};
	const unitPhoneme = (unit) => kana2phonon[unit] || kana2phonon[unit.replace(/ー+$/g,"")];
	const unitFeature = (unit) => {
		if(unitFeatureCache.has(unit))return unitFeatureCache.get(unit);
		const phoneme = unitPhoneme(unit);
		const vowel = featureCode(vowelCodes, phoneme ? phoneme[1].slice(-1) : unit);
		const consonant = featureCode(consonantCodes, phoneme ? phoneme[0].split("+")[0] : unit);
		//上位8bitに母音、下位8bitに子音を置く。未知ユニットが増えても、
		//現行の音素種類数を前提にしたbit衝突を起こさないよう余裕を持たせる。
		const feature = (vowel << 8) | consonant;
		unitFeatureCache.set(unit,feature);
		return feature;
	};
	const coarseSignature = (units) => {
		if(signatureCache.has(units))return signatureCache.get(units);
		const signature = String.fromCharCode(...units.map(unitFeature));
		signatureCache.set(units,signature);
		return signature;
	};
	//candidateWeightsは変種の出力位置から元歌詞位置へsrcIndexで写した重み。
	//正確距離と同じくユニット距離だけへ掛け、VARIATION_COSTは無重みのままにする。
	const coarseDistance = (targets, word, vowelRatio=0.8, variationWeight=1,
		candidateWeights=null) => {
		const wordSignature = coarseSignature(word.pronunciation);
		let best = Infinity;
		for(const target of targets){
			const targetSignature = coarseSignature(target);
			const weights = candidateWeights ? candidateWeights.get(target) : null;
			let score = ((target.vcost||0)+(word.vcost||0))*variationWeight;
			for(let i=0;i<target.length;i++){
				const targetFeature = targetSignature.charCodeAt(i);
				const wordFeature = wordSignature.charCodeAt(i);
				const weight = weights ? weights[i] : 1;
				if((targetFeature>>>8)!==(wordFeature>>>8))score += 5*vowelRatio*weight;
				if((targetFeature&255)!==(wordFeature&255))score += 5*(1-vowelRatio)*weight;
			}
			if(score<best)best=score;
		}
		return best;
	};

	//安定順序を保って上位limit件だけを最大ヒープに残す。全件sortに比べ、
	//大規模単語リストの一時配列・比較回数を抑える。
	const takeBestBy = (values, limit, getScore) => {
		if(!(limit>0))return [];
		if(values.length<=limit){
			return values.map((value,index)=>({value,index,score:getScore(value)}))
				.sort((a,b)=>a.score-b.score || a.index-b.index).map(v=>v.value);
		}
		const heap=[];
		const worse=(a,b)=>a.score>b.score || (a.score===b.score && a.index>b.index);
		const siftDown=(index)=>{
			while(true){
				let worst=index;
				const left=index*2+1;
				const right=left+1;
				if(left<heap.length && worse(heap[left],heap[worst]))worst=left;
				if(right<heap.length && worse(heap[right],heap[worst]))worst=right;
				if(worst===index)break;
				[heap[index],heap[worst]]=[heap[worst],heap[index]];
				index=worst;
			}
		};
		for(let index=0;index<values.length;index++){
			const entry={value:values[index],index,score:getScore(values[index])};
			if(heap.length<limit){
				heap.push(entry);
				let child=heap.length-1;
				while(child>0){
					const parent=(child-1)>>1;
					if(!worse(heap[child],heap[parent]))break;
					[heap[child],heap[parent]]=[heap[parent],heap[child]];
					child=parent;
				}
			}else if(worse(heap[0],entry)){
				heap[0]=entry;
				siftDown(0);
			}
		}
		heap.sort((a,b)=>a.score-b.score || a.index-b.index);
		return heap.map(v=>v.value);
	};
	const assignDefaultParameter = (parameters) => {
		const DEFAULT_PARAMETER_VALUES_ = {
				REPEAT: "100",
				SPLITTER: "/",
				DUPLICATE: true,
				//0で正確全件検索。既定は粗上位512件だけ正確距離で再採点する。
				APPROX_CANDIDATES: DEFAULT_APPROXIMATE_CANDIDATES,
				SAME_PHRASE_BREAK_REWARD: 1,//文節が一致しているとき掛け算する
				MID_PHRASE_BREAK_PENALTY: 0, //文節の途中で単語が切れることへのペナルティ(0で従来と同一) #98
				WORD_NUMBER_PENALTY: 1, //単語数に対するペナルティ
				VARIATION_COST: 0, //ン/ッ/ーの1変換操作あたりのコスト(0で無効。#105)
				LENGTH: 1
		}
		return Object.assign(DEFAULT_PARAMETER_VALUES_,parameters);
	}
	
	//文字列sとtの置換コストを求める
	//weights(省略可): sのユニット位置ごとの重み(平均1に正規化済み)。
	//省略時は全位置1と同じで従来と完全同一。ユニット位置別の重み付けスコアリング用
	const ld = (s,t, kanaDist, weights=null) => {
		//const kanaDist = KANA_SIMILARITY_;
		if(!s || !t)return Inifinity;
		if(s.length !== t.length)return Infinity;
		let score = 0;
		for(let i=0;i<s.length;i++){
			if(s[i] in kanaDist && t[i] in kanaDist){
				const d = kanaDist[s[i]][t[i]];
				score += weights ? d*weights[i] : d;
			}else{
				return Infinity;
			}
		}
		return score;
		
		if(typeof s === "undefined" ||  typeof t === "undefined")
			console.log("ld",s,t);
		console.log("ld_kanadist",kanaDist);
		return zip(s,t).reduce((prev,[v1,v2])=> {
			if(!(v1 in kanaDist)){
				//console.log(v1);
				return prev+100;
			}else if(!(v2 in kanaDist[v1])){
				//console.log(v2);
				return prev+100;
			}
			else{
				prev += kanaDist[v1][v2];
				return prev;
			}
			},0);
	}
	
	//入力にkanaDist下で距離の近い単語を求める
	//variationCost: ン/ッ/ーの1変換操作あたりに加算するコスト(#105)。
	//weights(省略可): targetのユニット位置ごとの重み(平均1に正規化済み・targetと同じ長さ)。
	//省略時は従来と完全同一。変種でユニット数が変わる場合は変種側の由来index(srcIndex)を
	//たどって元音節の重みを引く
	const getSimilarWord = (wordlist,target,kanaDist,length=1,variationCost=0,weights=null,
		approximateLimit=0,approximateVowelRatio=0.8) => {
		//console.log(kanaDist);
		const orglen = target.length;
			//Object.keysでは文字列配列が取得できるので、v.lengthも文字列に直してからfilterする
		
		//発音候補を長さごとに分類して取得
		//console.log("in gs start");
		//console.time("in gs");
		let tmp = textAnalyzer.syllableToVariation(target);
		let candidates = {};
		//変種ごとの重み(出力ユニット→由来音節の重み)。単語ごとに作り直さないよう先に用意する
		const candidateWeights = weights ? new Map() : null;
		for(let c of tmp){
			//発音cの長さがwordlistに存在しないときスキップ
			if(c.length in wordlist == false) continue;

			if(c.length in candidates == false) candidates[c.length]=[]
			candidates[c.length].push(c);
			if(candidateWeights){
				const src = c.srcIndex || [];
				//由来indexが取れない場合(古い変種)は重み1=無重みにフォールバック
				candidateWeights.set(c, c.map((_,k)=>{
					const w = weights[src[k]];
					return (typeof w === "number") ? w : 1;
				}));
			}
		}
		//console.timeLog("in gs");
		//粗検索は発音entryではなく単語ID単位でK件を選ぶ。同じIDに複数の読み・
		//変種があってもK枠を重複消費させず、選ばれたIDの全entryを正確再採点する。
		let approximateIds = null;
		if(approximateLimit>0){
			const relevantWords = Object.keys(candidates).reduce((sum,i)=>sum+wordlist[i].length,0);
			//小辞書では粗検索の固定費の方が高い。raw entry数だけならSetも作らず判定し、
			//rawが多い場合だけunique ID数を調べる。
			let useApproximation = relevantWords>approximateLimit*2;
			if(useApproximation){
				const uniqueIds = new Set();
				for(const i in candidates)for(const word of wordlist[i])uniqueIds.add(word.id);
				useApproximation = uniqueIds.size>approximateLimit*2;
			}
			if(useApproximation){
				const bestById = new Map();
				for(const i in candidates){
					for(const word of wordlist[i]){
						const score = coarseDistance(candidates[i],word,approximateVowelRatio,
							variationCost/16,candidateWeights);
						const previous = bestById.get(word.id);
						if(!previous || score<previous.score)bestById.set(word.id,{id:word.id,score});
					}
				}
				const selected = takeBestBy([...bestById.values()],approximateLimit,v=>v.score);
				approximateIds = new Set(selected.map(v=>v.id));
			}
		}
		let words = {}
		for(let i in candidates){
			for(let w of wordlist[i]){
				if(approximateIds && !approximateIds.has(w.id))continue;
				//共有オブジェクトを直接書き換えるとDPの再帰中に別セグメントの
				//クエリがsimを上書きし、スコア計算が汚染される(#99)。コピーに載せる
				let sim = Infinity;
				for(let c of candidates[i]){
					//ldの生スコアに変種コスト(ターゲット側 c.vcost + 単語側 w.vcost)を
					//加算した素の合計にする(#105)。旧正規化(÷変種長×音節数)は
					//対角0の新行列(#102/#104)では希釈の副作用だけが残るため廃止。
					//ユニット位置別の重みは ld のユニット距離にだけ掛ける。VARIATION_COST は
					//無重みのまま(将来、変種操作が起きた位置の重みで重み付けする拡張は可能)
					let d = ld(c, w.pronunciation, kanaDist, candidateWeights ? candidateWeights.get(c) : null)
						+ ((c.vcost||0)+(w.vcost||0))*variationCost;
					sim = Math.min(d, sim);
				}
				if(w.id in words && sim > words[w.id].sim) continue;
				words[w.id] = Object.assign({}, w, {sim: sim});
			}
		}
		//console.timeLog("in gs");
		let words2 = []
		for(let id in words){
			words2.push(words[id]);
		}
		//console.timeEnd("in gs");
		return takeBestBy(words2,length,w=>w.sim);
	}

	function getMin(array, getValue){
		let min = Infinity;
		let content = null;
		for(let v of array){
			const val = getValue(v);
			if(val < min){
				content = v;
				min = val;
			}
		}
		return content;
	}
	
    const Memo = function(){
    	const m = {}
    	return {
    		set: function(start,end,value){
    			if(start in m == false)m[start]={}
    			m[start][end]=value;
    		},
    		get: function(start,end,dft=null){
    			if(start in m === false || end in m[start] === false)return dft;
    			return m[start][end];
    		},
    		has: function(start,end){
    			return (start in m && end in m[start]);
    		}
    	}
    };

	
	//locks: 固定する単語のリスト(生成結果の単語オブジェクト。period[開始,終了]を持つこと)。
	//固定区間はそのまま残し、隙間だけDPで再生成する(編集ツール #17 用)
	//getSimilarWordFuncは (subtarget, 開始index, 終了index) で呼ぶ。位置は重み付き
	//スコアリングのために渡すだけで、無重みの実装は従来どおり第1引数だけ見ればよい
	function convert(tokens, getSimilarWordFunc, used_words, param={}, locks=null){
		const splitter=param.SPLITTER;
		const repeat = param.REPEAT;
		const isDuplicate = param.DUPLICATE;
		const samePhraseBreak = param.SAME_PHRASE_BREAK_REWARD;
		const midPhraseBreak = param.MID_PHRASE_BREAK_PENALTY || 0; //未指定(旧呼び出し元)は0=従来と同一 #98
		const wordsNum = param.WORD_NUMBER_PENALTY;
		const takeLen = param.LENGTH;
		
        //固定単語は使用済み扱いにする(DUPLICATE=falseのとき再利用されないように)。
        //固定区間の隙間を順に生成する際、前の区間の採用単語も追記していく(可変配列)
        //fillerはidを持たないので使用済みには含めない(固定されたfillerが来ても同じ)
        const used = (locks && locks.length > 0)
			? used_words.concat(locks.filter(v=>!v.filler).map(v=>v.id))
			: used_words;
        
		const target = tokens.map(v=>v.pronunciation);
		// 1文字の読みが複数ユニットになる場合（例: 畑=ハ・タ・ケ）、
		// surface_form は先頭ユニットだけが所有する。文字の途中を自動生成の
		// 単語境界にすると「畑 / ハ」と「 / タケ」に分かれ、元歌詞の表記と
		// 読みの対応が崩れるため、DP の内部境界は文字境界だけに限定する。
		// 固定つき再生成では既存の period が文字途中にある可能性があるので、
		// 区間の端点 s/t 自体は許容し、その内側の分割点だけを制限する。
		const isCharacterBoundary = (index) => index <= 0 || index >= tokens.length
			|| tokens[index - 1].char_index !== tokens[index].char_index;
		const phraseBreaks = tokens.map((v,j)=>{
			if(j===0)return 0;
			else if(v.phrase !== tokens[j-1].phrase){
				return j;
			}else{
				return -1;
			}
		}).filter(v=>v>-1);

        const memo = Memo();
        memo.set(0,0,[0,[]]);

        const dp = (s,t) => {
			if(memo.has(s,t)){
				//console.log("st",s,t);
				return memo.get(s,t);
			}
			if(s===t){
				memo.set(s,t,[0,[]]);
				return memo.get(s,t);
			}
			
			const results = [];
			for (let i = s; i<t; i++){
				if(i !== s && !isCharacterBoundary(i))continue;
				//if ( number.includes(t-i) == false )continue
				const subtarget = target.slice(i,t);

				const r = dp(s,i);
				//console.log(s,i,t,r);
				//console.log(s,i,r);

				if(!r)continue;

				const prev_score = r[0];
				if(prev_score === Infinity)continue;

				const prev_words = r[1];

				//1文字区間には必ず filler(万能候補)を選択肢として置く(#128)。
				//通常は1文字=1ユニットだが、漢字などは1文字が複数ユニットになるため、
				//文字境界を守ったまま読み全体を1つのfillerにする。
				//コストが巨大なので実単語が置ける区間では必ず負け、単語が尽きた/
				//どの単語も合わない区間だけ「元歌詞のまま」で残る。これで
				//「候補が無い→行が丸ごと空」という経路が無くなる。
				//文節の報酬・ペナルティは単語の切れ目に対する調整なので未変換の
				//fillerには掛けない(経路の優劣がfillerの個数だけで決まるようにする)
				const firstCharIndex = tokens[i] && tokens[i].char_index;
				const isSingleCharacterSpan = t - i === 1
					|| (firstCharIndex != null && tokens.slice(i, t)
						.every(token => token.char_index === firstCharIndex));
				if(isSingleCharacterSpan){
					const kana = subtarget.join("");
					const filler_words = [].concat(prev_words);
					filler_words.push({
						surface: kana,
						pronunciation: kana,
						kana: kana,
						original: "",
						filler: true,
						sim: FILLER_COST,
						score: FILLER_COST,
						originalkana: kana,
						period: [i,t]
					});
					results.push([prev_score + FILLER_COST + wordsNum, filler_words]);
				}

				const similarWords = getSimilarWordFunc(subtarget, i, t);
				if(!similarWords){
					continue;
				}

				//fillerはidを持たない仮想語なので、使用済み(単語重複なし)の判定からは外す
				const currentUsed = prev_words.filter(v=>!v.filler).map(v=>v.id);


				const newWord = (function(words){
					if(words.length===0)return null;
					if(isDuplicate)return Object.assign({},words[0]);
					
					for(let w of words){
						if(used.includes(w.id) === false && currentUsed.includes(w.id)===false){
							return Object.assign({},w);
						}
					}
				})(similarWords);
				
				if(!newWord) continue;
				
				newWord.originalkana = subtarget.join("");

				newWord.score = newWord.sim;
				if(phraseBreaks.includes(t)){
					//wscore -= samePhraseBreak*1;
					newWord.score -= samePhraseBreak*1;
				}else if(t !== target.length){
					//文節の途中で単語が切れる(終端が文節境界にも行末にも一致しない)ペナルティ #98
					newWord.score += midPhraseBreak;
				}
				newWord.period = [i,t];
				
				const new_score = prev_score + newWord.score + wordsNum;
				const new_words = [].concat(prev_words);
				new_words.push(newWord);
				results.push([new_score, new_words]);
			}
			//console.timeLog("dp");
			//結果が存在しなければ、スコアを無限にする
			if(results.length == 0){
				let result = [Infinity, []];
				memo.set(s,t,result);
				return result;
			}
			const result = getMin(results, v=>v[0]);
			//console.log("check",s,t,mini_result,result);
			//console.timeEnd("dp");
			memo.set(s,t, result);
			return result;

		}
		if(locks && locks.length > 0){
			//固定単語をperiod順に並べ、隙間区間だけDPして結合する
			const sorted = [].concat(locks).sort((a,b)=>a.period[0]-b.period[0]);
			let score = 0;
			let words = [];
			let cursor = 0;
			const takeSegment = (s, t) => {
				const r = dp(s, t);
				if(r && r[0] !== Infinity){
					score += r[0];
					words = words.concat(r[1]);
					//後続区間で同じ単語を再利用しないよう使用済みに追記
					//(usedはdpがクロージャ経由で毎回参照するため反映される)
					for(const w of r[1]) if(!w.filler) used.push(w.id);
				}
			};
			for(const lw of sorted){
				const [ls, le] = lw.period;
				if(cursor < ls) takeSegment(cursor, ls);
				words.push(lw);
				cursor = Math.max(cursor, le);
			}
			if(cursor < target.length) takeSegment(cursor, target.length);
			return [score, words];
		}
		return dp(0,target.length);
	}

	//ユニット位置別の重みを平均1へ正規化する(重み付きスコアリング用)。
	//・長さがユニット数と違う / 非有限や負の値が混じる / 総和が0以下 → nullを返し、
	//  呼び出し側はその行を「重みなし」(従来と完全同一)として扱う。警告だけ出す
	//・平均1に揃えるので、重み全体のスケールはスコアに影響しない(単語数ペナルティ等の
	//  他の項との相対関係が重みの与え方で勝手に変わらないようにするため)
	function normalizeWeights(weights, unitCount, label){
		if(weights === null || typeof weights === "undefined")return null;
		if(!Array.isArray(weights) || weights.length !== unitCount){
			console.warn(`[soramimic] 重みの長さがユニット数と一致しません(${label}: `
				+ `${Array.isArray(weights)?weights.length:typeof weights} != ${unitCount})。この行は重みなしで処理します`);
			return null;
		}
		let sum = 0;
		for(const w of weights){
			if(typeof w !== "number" || !isFinite(w) || w < 0){
				console.warn(`[soramimic] 重みに非負の有限数でない値が含まれます(${label}: ${w})。この行は重みなしで処理します`);
				return null;
			}
			sum += w;
		}
		if(!(sum > 0)){
			console.warn(`[soramimic] 重みの総和が0以下です(${label})。この行は重みなしで処理します`);
			return null;
		}
		const scale = unitCount / sum;//平均1に正規化
		return weights.map(w=>w*scale);
	}

	//選択範囲(発音ユニット配列)に対する類似単語候補の上位を返す(編集ツール #17 用)。
	//単語リスト内のオブジェクトを直接返さずコピーする(呼び出し側の編集がDBを汚さないように)
	//weights(省略可): targetと同じ長さのユニット位置別重み。省略時は従来と完全同一
	function getCandidates(wordlist, target, parameter, length=30, weights=null){
		const param = assignDefaultParameter(parameter);
		const kanaDist = kanaSimilarity.getKanaSimilarity(param);
		const w = normalizeWeights(weights, (target||[]).length, "getCandidates");
		const configuredLimit = Number(param.APPROX_CANDIDATES);
		const approximateLimit = Number.isFinite(configuredLimit) && configuredLimit>0
			? Math.max(Math.floor(configuredLimit),length) : 0;
		const words = getSimilarWord(wordlist,target,kanaDist,length,param.VARIATION_COST,w,
			approximateLimit,param.VOWEL_RATIO??0.8) || [];
		return words.slice(0, length).map(w=>Object.assign({}, w));
	}

	//weightsPerLine(省略可): 行ごとのユニット位置別重み。generateFromTokens と同じ意味
	function generate(phrases, wordlist, parameter, updateFunc,endFunc, weightsPerLine=null){
		const tokens_list = textAnalyzer.tokenizeTogether(phrases);
		return generateFromTokens(tokens_list, wordlist, parameter, updateFunc, endFunc, null, weightsPerLine);
	}

	//事前トークナイズ済みの入力から生成する(非同期トークナイザ対応用。#25)
	//tokens_listは textAnalyzer.tokenizeTogether(phrases) と同形式であること
	//locksPerLine(省略可): 行ごとの固定単語リスト。指定行は固定区間以外だけ再生成される
	//weightsPerLine(省略可): 行ごとのユニット位置別の重み(その行の音節ユニット数と同じ長さの
	//  非負数値配列)。行内で平均1に正規化し、ユニット単位の距離に掛ける。強調したい位置の
	//  重みを上げると、その位置で音が合う候補が選ばれやすくなる。
	//  省略・null・不正(長さ不一致/総和0以下)の行は重みなし=従来と完全同一の挙動
	function generateFromTokens(tokens_list, wordlist, parameter, updateFunc,endFunc, locksPerLine=null, weightsPerLine=null){
		const param = assignDefaultParameter(parameter);
		const kanaDist = kanaSimilarity.getKanaSimilarity(param);
		const tokenized_phrases = tokens_list.map(v=>textAnalyzer.getYomiAndPhraseBreak(v));
		const totalUnits = tokenized_phrases.reduce((sum,tokens)=>sum+tokens.length,0);
		//重複なしでは、それ以前と現在の経路で使われ得る実単語数は全ユニット数以下。
		//その数+1件を正確候補として保持すれば、未使用候補がある限り到達できる。
		//粗候補Kも歌詞が長いときは同じ下限まで広げ、後半行の候補切れを防ぐ。
		const candidateLimit = param.DUPLICATE ? 1 : totalUnits+1;
		const configuredValue = Number(param.APPROX_CANDIDATES);
		const configuredApproximateLimit = Number.isFinite(configuredValue) && configuredValue>0
			? Math.floor(configuredValue) : 0;
		const approximateLimit = configuredApproximateLimit>0
			? Math.max(configuredApproximateLimit,candidateLimit) : 0;
		//重みなしの行で使う共有メモ(従来どおりカナ文字列キー。行をまたいで使い回せる)
		const gs = (function(){
			const gsmemo = {}
			return function(target){
				const joined_target = target.join("");
				if(joined_target in gsmemo)return gsmemo[joined_target];
				const result = getSimilarWord(wordlist,target,kanaDist,candidateLimit,
					param.VARIATION_COST,null,approximateLimit,param.VOWEL_RATIO??0.8);
				gsmemo[joined_target] = result;
				return result;
			}
		})();
		//重みありの行用。同じカナでも位置によってスコアが変わるので、メモのキーは位置範囲にする
		//(共有メモは汚さないよう行ごとに独立させる)
		const makeWeightedGs = (lineWeights) => {
			const gsmemo = {}
			return function(target, start, end){
				const key = start + ":" + end;
				if(key in gsmemo)return gsmemo[key];
				const result = getSimilarWord(wordlist,target,kanaDist,candidateLimit,
					param.VARIATION_COST,lineWeights.slice(start,end),approximateLimit,
					param.VOWEL_RATIO??0.8);
				gsmemo[key] = result;
				return result;
			}
		};
		console.log("tokens_list",tokens_list);

		let used_words = [];
		const results = [];
		//cancel()で以降の行処理とendFuncを止める。出力自体は変えない追加API(#116)
		let cancelled = false;

		//setTimeoutを数珠つなぎに実行する関数
		function convert_line(i,delayMsec){
			if(cancelled)return;
			if(i>=tokenized_phrases.length){
				if(endFunc){
					setTimeout(()=>{
						if(!cancelled)endFunc(results);
					},delayMsec);
				}
			}else{
				setTimeout(()=>{
					if(cancelled)return;
					const tokens = tokenized_phrases[i];
					const lineWeights = weightsPerLine
						? normalizeWeights(weightsPerLine[i], tokens.length, `行${i}`)
						: null;
					const raw_result = convert(tokens, lineWeights ? makeWeightedGs(lineWeights) : gs,
						used_words, param,
						locksPerLine ? locksPerLine[i] : null);

					console.log("raw_result",raw_result);
					let result = [];
					if(raw_result){
						result = raw_result[1].map(v=>{
							//console.log("v",v);
							let original_surface = tokens.slice(v.period[0],v.period[1]).map(v=>{
								return v.surface_form;
							}).join("");
							v.original_surface = original_surface;
							return v;				
						});
					}
					if(updateFunc){
						updateFunc(result, i, tokenized_phrases);					
					}
					//fillerは実単語ではないので使用済み(単語重複なし)には数えない
					used_words = used_words.concat(result.filter(v=>!v.filler).map(v=>v.id));
					results.push(result);
					convert_line(i+1);
				},delayMsec);
			}
		}
		convert_line(0,50);
		//中止用ハンドルを返す(従来の戻り値trueはどの呼び出し元も使っていなかった)
		return {
			cancel: function(){ cancelled = true; }
		};

	}
		
	
	return {
		generate: generate,
		generateFromTokens: generateFromTokens,
		getCandidates: getCandidates,
		FILLER_COST: FILLER_COST //テスト・呼び出し側の検証用に公開する
	}

};
export { SoramimiMaker, FILLER_COST };
