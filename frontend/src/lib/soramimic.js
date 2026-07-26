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



const SoramimiMaker = (kanaSimilarity, textAnalyzer)=>{
	const assignDefaultParameter = (parameters) => {
		const DEFAULT_PARAMETER_VALUES_ = {
				REPEAT: "100",
				SPLITTER: "/",
				DUPLICATE: true,
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
	const getSimilarWord = (wordlist,target,kanaDist,length=1,variationCost=0,weights=null) => {
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
		let words = {}
		for(let i in candidates){
			for(let w of wordlist[i]){
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
		words2.sort((a,b)=>a.sim-b.sim);
		//console.timeEnd("in gs");
		return words2;
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
        const used = (locks && locks.length > 0)
			? used_words.concat(locks.map(v=>v.id))
			: used_words;
        
		const target = tokens.map(v=>v.pronunciation);
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
				//if ( number.includes(t-i) == false )continue
				const subtarget = target.slice(i,t);
				const similarWords = getSimilarWordFunc(subtarget, i, t);
				if(!similarWords){
					continue;
				}
				
				const r = dp(s,i);
				//console.log(s,i,t,r);
				//console.log(s,i,r);
				
				if(!r)continue;
				
				const prev_score = r[0];
				if(prev_score === Infinity)continue;
				
				const prev_words = r[1];
				
				const currentUsed = prev_words.map(v=>v.id);


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
					for(const w of r[1]) used.push(w.id);
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
		const words = getSimilarWord(wordlist, target, kanaDist, length, param.VARIATION_COST, w) || [];
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
		//重みなしの行で使う共有メモ(従来どおりカナ文字列キー。行をまたいで使い回せる)
		const gs = (function(){
			const gsmemo = {}
			return function(target){
				const joined_target = target.join("");
				if(joined_target in gsmemo)return gsmemo[joined_target];
				const result = getSimilarWord(wordlist, target, kanaDist, 100, param.VARIATION_COST);
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
				const result = getSimilarWord(wordlist, target, kanaDist, 100, param.VARIATION_COST,
					lineWeights.slice(start, end));
				gsmemo[key] = result;
				return result;
			}
		};
		console.log("tokens_list",tokens_list);
		const tokenized_phrases = tokens_list.map(v=>textAnalyzer.getYomiAndPhraseBreak(v));
		
		
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
					used_words = used_words.concat(result.map(v=>v.id));
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
		getCandidates: getCandidates
	}
	
};
export { SoramimiMaker };
