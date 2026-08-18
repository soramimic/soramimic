// js/TextAnalyzer.js から移植(ロジック無改変、ESモジュール化のみ)
import { removeSign } from "./utils.js";
import { TokenFormatter } from "./character.js";
import { hiraToKata, removeUnnaturalKanaPattern, absorbSmallKana } from "./kanaToSyllable.js";
import { parseRuby } from "./ruby.js";

//ルビ記法(｜表層《よみ》)の注釈区間に割り当てる強制トークン。
//kuromoji(ipadic)形式に合わせた既定値を持ち、posは名詞にして
//TokenFormatterの文節ヒューリスティックで文節カウントが進むようにする。
//ruby:true は「読みが確定済み」の目印で、以降の推定・結合処理が読みを
//上書き/破壊しないためのガードに使う
function makeRubyToken(surface, reading){
	return {
		surface_form: surface,
		basic_form: surface,
		reading: reading,
		pronunciation: reading,
		pos: "名詞",
		pos_detail_1: "一般",
		pos_detail_2: "*",
		pos_detail_3: "*",
		conjugated_form: "*",
		conjugated_type: "*",
		word_position: 1,
		ruby: true,
	};
}

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
		const { chunks, plan } = splitByRuby(texts);
		let tokens_list = mergeRubyTokens(tokenizeSentenses(chunks), plan);
		return formatTokensList(tokens_list);
	}

	//ルビ記法の前処理: 記法を解決した素テキストを注釈境界で分割し、
	//トークナイザに渡すチャンク列(chunks)と、結合手順(plan)を返す。
	//記法を含まない行は行全体が1チャンクになるので、従来と完全に同じ入力が
	//トークナイザに渡る(=出力も従来と一致する)。
	//kuromoji経路(tokenizeTogether)と読み推定API経路(app.js)の両方から使えるよう、
	//「分割」と「結合」を分けて公開している
	function splitByRuby(texts){
		const chunks = [];
		const plan = texts.map(text=>{
			const { plain, annotations } = parseRuby(text);
			if(annotations.length === 0){
				const items = [{ type:"chunk", index: chunks.length }];
				chunks.push(plain);
				return items;
			}
			//注釈オフセットはコードポイント単位なので、UTF-16のsliceは使わない
			const chars = Array.from(plain);
			const items = [];
			const pushChunk = (start,end)=>{
				const s = chars.slice(start,end).join("");
				if(s === "")return;
				items.push({ type:"chunk", index: chunks.length });
				chunks.push(s);
			};
			let pos = 0;
			for(const ann of annotations){
				pushChunk(pos, ann.start);
				items.push({
					type:"ruby",
					surface: chars.slice(ann.start, ann.end).join(""),
					reading: ann.reading,
				});
				pos = ann.end;
			}
			pushChunk(pos, chars.length);
			return items;
		});
		return { chunks, plan };
	}

	//splitByRubyのchunksをトークナイズした結果を、行ごとのトークン列に組み直す。
	//注釈区間は強制トークン1個に置き換わる。
	//word_positionはチャンク単位でしか正しくないため、記法を含む行だけ再計算する
	//(記法を含まない行はトークナイザの出力をそのまま保つ=後方互換)
	function mergeRubyTokens(chunkTokensList, plan){
		return plan.map(items=>{
			const tokens = [];
			let hasRuby = false;
			for(const item of items){
				if(item.type === "ruby"){
					hasRuby = true;
					tokens.push(makeRubyToken(item.surface, item.reading));
				}else{
					const chunk = chunkTokensList[item.index];
					if(chunk)for(const token of chunk)tokens.push(token);
				}
			}
			if(hasRuby){
				let pos = 1;
				for(const token of tokens){
					token.word_position = pos;
					pos += Array.from(token.surface_form || "").length;
				}
			}
			return tokens;
		});
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
					//ルビ記法で読みを明示指定したトークンは英語読みで上書きしない
					if(!token.ruby){
					//if(token.pronunciation === "*"){
						token.pronunciation = english.toKana(token.surface_form);
					//}
					}
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
		//英字の並びはマッチした部分だけをカナ化して置換する。
		//(以前はtext全体をtoKanaした結果で置換しており、英字がk箇所あると読みが
		// 約k+1倍に膨張して後段のバリエーション展開が指数爆発していた)
		text = text.replace(/[a-zA-Z']+/g,function(match){
			return english.toKana(match);
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
		splitByRuby: splitByRuby,
		mergeRubyTokens: mergeRubyTokens,
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
