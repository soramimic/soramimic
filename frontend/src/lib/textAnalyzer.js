// js/TextAnalyzer.js から移植(ロジック無改変、ESモジュール化のみ)
import { removeSign } from "./utils.js";
import { TokenFormatter } from "./character.js";
import { hiraToKata, removeUnnaturalKanaPattern, absorbSmallKana } from "./kanaToSyllable.js";

//kuromojiのtokenizer, English(), Character(),KanaToSyllable()を内部で使用
//function TextAnalyzer(tokenizer, englishdictionary, romantree, kanji_dict){
function TextAnalyzer(character, kanaToSyllable, english, tokenizeSentenses,getYomi){
	//const k2p = KanaConverter.getKana2Phonon();
	//const english = English(englishdictionary, romantree);
	const tf = TokenFormatter();
	const kanji = character.kanji;
	console.log("kanji",kanji);
	//console.log("token formatter",tf);
	//const kanji = Kanji(kanji_dict)
	//const character = Character(kanji);
	//const k2s = KanaToSyllable();
	const k2s = kanaToSyllable;
	
	function tokenizeTogether(texts){
		const AP = english.apostrophe;
		texts = texts.map(v=>AP.toString(v));
		let tokens_list = tokenizeSentenses(texts);
		return formatTokensList(tokens_list);
	}

	//トークン列への後処理(英語・漢字の読み補完、記号処理、文節付与)。
	//外部トークナイザ(読み推定API等)の結果にも同じ処理を通せるよう分離(#25)
	function formatTokensList(tokens_list){
		const AP = english.apostrophe;
		tokens_list = tokens_list.map(tokens=>{
			tokens = tokens.map(token=>{
				if(english.isFullmatch(token.surface_form)){
					//console.log("english fullmatched");
					token.surface_form = AP.toSign(token.surface_form);
					//if(token.pronunciation === "*"){
						token.pronunciation = english.toKana(token.surface_form);					
					//}
				}
				return token;
			});

			//console.log("tokens",tokens);
			tokens = tokens.map(token=>{
				if(token.pronunciation === "*" && kanji.isFullmatch(token.surface_form)){
					const p = kanji.toKana(token.surface_form);
					if(p) token.pronunciation = p;
					//console.log("kanji",p);
				}
				return token;
			});

			//pronunciationが*で、surfaceが平仮名、カタカナ、記号のみのとき、カタカナを読みとする
			tokens = tokens.map(token=>{
				if(token.pronunciation !== "*") return token;
				let s = token.surface_form;
				s = removeSign(s); //記号削除
				s = hiraToKata(s); //平仮名をカタカナに変換
				if(/^[\u{3000}-\u{301C}\u{30A1}-\u{30F6}\u{30FB}-\u{30FE}]+$/u.test(s)){//sが全部カタカナであれば
					token.pronunciation = s;	
				}
				return token;
			});

			tokens = tf.format(tokens);
			tokens = tokens.map(token=>{
				if(token.pronunciation === "*")token.pos = "記号";
				return token;
			});
			tokens = absorbSmallKanaInTokens(tokens);
			return tokens;
		});
		return tokens_list;
	}

	//読みに残った小書きカナ(「ハァ」「ウッセェ」など)を大文字に吸収する。
	//単独の小書きはどの単語の発音にも現れない(単語リスト側はformatKanaで正規化済み)
	//ため、放置すると行全体の候補が0件になる。
	//トークンをまたぐ組み合わせ(「シ」+「ェ」)も拾えるよう行単位で連結して正規化する。
	//absorbSmallKanaは1文字→1文字の置換で長さを変えないので、そのままトークン境界で
	//切り戻せる(surfaceとの位置対応も崩さない)
	function absorbSmallKanaInTokens(tokens){
		const joined = tokens.map(t=>(typeof t.pronunciation === "string")?t.pronunciation:"").join("");
		const absorbed = absorbSmallKana(joined);
		if(absorbed === joined)return tokens;
		let pos = 0;
		for(const token of tokens){
			if(typeof token.pronunciation !== "string")continue;
			const len = token.pronunciation.length;
			token.pronunciation = absorbed.slice(pos,pos+len);
			pos += len;
		}
		return tokens;
	}
	function getYomiFromTokens(tokens){
		//let tokens = tokenize(strVal);
		let yomi = tokens.map(v=>{
			if(v.pronunciation)return v.pronunciation;
			else return "";
		}).join("");
		//if(strVal=="タンノ"){
		//	console.log("getYomi",tokens,yomi);
		//}
		return removeSign(yomi);
	}
	
	//ひらがなをカタカナに変換
	function hiraToKata (str) {
	    return str.replace(/[\u3041-\u3096]/g, function(match) {
	        var chr = match.charCodeAt(0) + 0x60;
	        return String.fromCharCode(chr);
	    });
	}

	function formatKana(text){
		//console.log(text);
		text = text.replace(/[a-zA-Z']+/g,function(match){
			return english.toKana(text);
		});
		//text = english.toKana(text);
		text = hiraToKata(text);
		text = removeSign(text);
		text = removeUnnaturalKanaPattern(text);
		return text
	}
	
	function concatMora(tokens){
		//1文字が複数モーラへ対応すると、各モーラに同じsurfaceが複製される。
		//重複部分だけを除き、末尾に連結済みの空白・記号は元表記として残す。
		const surfaceByChar = new Map();
		tokens = tokens.map(token=>{
			const charIndex = token.char_index;
			const leadingSurface = token.leading_surface || "";
			if(!surfaceByChar.has(charIndex)){
				surfaceByChar.set(charIndex, token.surface_form);
				token.surface_form = leadingSurface + token.surface_form;
				return token;
			}
			const repeatedSurface = surfaceByChar.get(charIndex);
			token.surface_form = token.surface_form.startsWith(repeatedSurface)
				? token.surface_form.slice(repeatedSurface.length)
				: "";
			return token;
		});
		//console.log(1,tokens);
		let mora = [];
		let last_mora = -1;
		//console.log("token",tokens);
		for(let i=0;i<tokens.length;i++){
			let token = tokens[i];
			
			if(token.mora !== last_mora){
				last_mora = token.mora;
				mora.push(token);
			}else{
				mora[mora.length-1].surface_form += token.surface_form;
				mora[mora.length-1].pronunciation += token.pronunciation;
			}
		}
		return mora;
	}
	
	function getYomiAndPhraseBreak(tokens){
		//let tokens = tokenize(strVal);
		//console.log("getYomiAndPhraseBreak",tokens);
		tokens = character.tokenize(tokens);
		tokens = tokens.map(token=>{
			let obj = {}
			for(let v of ["surface_form","token_index","phrase","pronunciation","subword","char_index","leading_surface"]){
				obj[v]=token[v];
			}
			return obj;
		});
		
		let subword_kana = (function(){
			let kana = []
			let last_subword = -1;
			for(let token of tokens){
				if(token.subword !== last_subword){
					kana.push(token.pronunciation);
					last_subword = token.subword;
				}else{
					kana[kana.length-1] += token.pronunciation;
				}
			}
			return kana;
		})();
		let mora = subword_kana.map(v=>{
			return k2s.split(v);
		}).flat();
		console.log("mora",tokens,subword_kana,mora);
		let mora_index = mora.map((v,i)=>{
			let tmp = Array(v.length);
			tmp.fill(i);
			return tmp;
		}).flat();
		for(let i=0;i<mora_index.length;i++){
			tokens[i]["mora"] = mora_index[i];
		}
		//console.log("before",tokens);
		//moraの単位でtokenをまとめる
		tokens = concatMora(tokens);
		return tokens;
	}

	return {
		tokenizeTogether: tokenizeTogether,
		formatTokensList: formatTokensList,
		getYomiFromTokens: getYomiFromTokens,
		getYomiAndPhraseBreak: getYomiAndPhraseBreak,
		yomiToSyllable: function(yomi){
			//const yomi = getYomi(text);
			const sep = k2s.split(yomi);
			return sep;
		},
		syllableToVariation: k2s.getVariation,
		yomiToVariation: function(yomi, maxUnits){
			//const yomi = getYomi(text);
			const sep = k2s.split(yomi);
			const ptn = k2s.getVariation(sep, maxUnits);
			return ptn;
		},
		formatKana: formatKana,
		getYomi: getYomi
	}
}
//const ENGLISHDICT = loadJsonFileSync("data/english-kana.json");
//const ROMANTREE = loadJsonFileSync("data/tree_roma2kana.json");
//const KANJI_DICT = loadJsonFileSync("data/kanjiyomi.json");

//const textAnalyzer = TextAnalyzer(KuromojiTokenizer,ENGLISHDICT, ROMANTREE,KANJI_DICT);


export { TextAnalyzer };
