// js/KanaToSyllable.js から移植(ロジック無改変、ESモジュール化のみ)
import { zip, product } from "./utils.js";

function barToVowel(text){
	text = text.replace(/[ァ-ンヴ]ー/g,function(match){
		let first = match[0];
		let vowel = charToVowel(first);
		if(first == "ン")vowel = "ン";//ンは特別扱い
		else if(first == "ッ")vowel = "ッ";//ッも特別扱い
		return first+vowel;
	});
	return text;
}
function vowelToBar(text){
	text = text.replace(/[ァ-ンヴ][アイウエオ]/g,function(match){
		let first = match[0];
		let vowel = charToVowel(first);
		let res = match;
		if(vowel == match[1]){
			res = first+"ー";
		}else if(vowel == "エ" && match[1]=="イ"){
			res = first + "ー";
		}else if(vowel == "オ" && match[1] == "ウ"){
			res = first + "ー";
		}
		return res;
	});
}

function charToConsonant(char){
	
	let cols = {
			"sp":"アイウエオヲー",
			"k":"カキクケコ",
			"s":"サシスセソ",
			"t":"タチツテト",
			"n":"ナニヌネノ",
			"h":"ハヒフヘホ",
			"m":"マミムメモ",
			"y":"ヤユヨ",
			"r":"ラリルレロ",
			"w":"ワ",
			"g":"ガギグゲゴ",
			"z":"ザジヂズゼゾ",
			"d":"ダヅデド",
			"b":"バビブヴベボ",
			"p":"パピプペポ",
			"sp":"ンッ"
	}

	let first = char[0];
	let consonant = "";
	for(let c in cols){
		let col = cols[c];
		if(col.includes(first)){
			consonant = c;
			break;
		}
	}
	return consonant;
}


//同じ文字か判定
const isSameKana = (kana1,kana2) => {
	return kana1 == kana2;
}
//同じ母音か判定
const isSameVowel = (kana1,kana2) => {
	let v1 = charToVowel(kana1);
	let v2 = charToVowel(kana2);
	return v1 == v2;
}
//同じ子音か判定
const isSameConsonant = (kana1,kana2) => {
	let c1 = charToConsonant(kana1);
	let c2 = charToConsonant(kana2);
	return c1 == c2;
}
//どちらも長音かどうか
const isSameBar = (kana1,kana2) => {
	const checkChar = "ー",
		isKana1Ok = ( kana1.slice(-1) == checkChar),
		isKana2Ok = (kana2.slice(-1) == checkChar)
		;
	return (isKana1Ok && isKana2Ok);
}
//どちらも促音かどうか
const isSameSokuon = (kana1,kana2) => {
	const checkChar = "ッ",
		isKana1Ok = ( kana1.slice(-1) == checkChar),
		isKana2Ok = (kana2.slice(-1) == checkChar)
		;
	return (isKana1Ok && isKana2Ok);
}
//どちらも撥音かどうか
const isSameHatsuon = (kana1,kana2) => {
	const checkChar = "ン",
		isKana1Ok = ( kana1.slice(-1) == checkChar),
		isKana2Ok = (kana2.slice(-1) == checkChar)
	;
	return (isKana1Ok && isKana2Ok);
}

function hiraToKata(str){
    return str.replace(/[\u3041-\u3096]/g, function(match) {
        var chr = match.charCodeAt(0) + 0x60;
        return String.fromCharCode(chr);
    });
}

//日本語のカナの正規表現パターンをア段からオ段の音（と全部）に分けて取得
//日本語の場合、「ファ」などのように２文字で１モーラを構成するカナがあることに注意
function KanaPattern(){
	//ア段からオ段までの1文字カナ集合と「テ」「デ」の集合を定義
	let kana_a = "[アカサタナハマヤラワガザダバパ]";
	let kana_i = "[イキシチニヒミリギジヂビピ]";
	let kana_i2 = kana_i.replace("イ","");//ャュョとくっつける用のイ段
	let kana_u = "[ウクスツヌフムユルグズヅブプヴ]";
	let kana_e = "[エケセテネヘメレゲゼデベペ]";
	let kana_o = "[オコソトノホモヨロヲゴゾドボポ]";
	let kana_td = "[テデ]";
	//let kana_td2 = "[トド]";
	
	//２文字で１モーラになるカナの定義
	let kana_multi_a = "("+[kana_u+"[ァヮ]",kana_i2+"ャ",kana_td+"ャ"].join("|")+")";
	let kana_multi_i = "("+[kana_u+"ィ",kana_td+"ィ"].join("|")+")";
	let kana_multi_u = "("+[kana_i+"ュ",kana_td+"ュ","[トド]ゥ"].join("|")+")";
	let kana_multi_e = "("+[kana_u+"ェ",kana_i+"ェ"].join("|")+")";
	let kana_multi_o = "("+[kana_u+"ォ",kana_i2+"ョ"].join("|")+")";
	let kana_multi = "("+[kana_u+"[ァィェォ]",kana_td+"[ャィュョ]",kana_i+"[ャュョ]",kana_i2+"ェ","[トド]ゥ"].join("|")+")";
	
	//ンーッと小文字を除くカナ
	let kana_single_base = "[アイウエオ-ヂツ-モヤユヨ-ロワヲヴ]";
	//２文字で１モーラとなるカナも含めた全カナ集合(ー/ン/ッと小文字単体は除く)の定義
	let kana_base = "("+[kana_multi, kana_single_base].join("|")+")";
	//２文字で１モーラとなるカナも含めた全カナ集合(ー/ン/ッと小文字単体も含む)の定義
	let kana_all = "("+[kana_multi, "[ァ-ヴー]"].join("|")+")";
	
	return {
	  "base":kana_base,
	  "all":kana_all,
	  "multi_a":kana_multi_a,
	  "multi_i":kana_multi_i,
	  "multi_u":kana_multi_u,
	  "multi_e":kana_multi_e,
	  "multi_o":kana_multi_o,
	  "multi":kana_multi,
	  "single_a":kana_a,
	  "single_i":kana_i,
	  "single_u":kana_u,
	  "single_e":kana_e,
	  "single_o":kana_o,
	  "single_td":kana_td,
	  "single_base":kana_single_base
	}
}
//文字を母音に変換
function charToVowel(char){
	if(char == "ー" ){
		//console.log("warning: only ー is input");
		return char;
	}

	//伸ばし棒を除いた末尾の文字を取得
	let last = char[char.length-1];
	for(let i=char.length-1;i>-1;i--){
		last = char[i];
		if(last != "ー")break;
	}
	
	let rows = {
			"ア":"アカサタナハマヤラワガザダバパァャヮ",
			"イ":"イキシチニヒミリギジヂビピィ",
			"ウ":"ウクスツヌフムユルグズヅブプヴゥュ",
			"エ":"エケセテネヘメレゲゼデベペェ",
			"オ":"オコソトノホモヨロゴゾドボポォ",
			"sp":["sp","ン","ッ"]
	}
	let vowel = last;
	for(let v in rows){
		let row = rows[v];
		if(row.includes(last)){
			vowel = v;
			break;
		}
	}
	return vowel;
}

//小文字母音を長音に変換
function smallVowelToBar(text){
	//長音のうしろの小文字母音を長音に
	//let replaced_text = text.replace(/(?<=ー)(ァ+|ィ+|ゥ+|ェ+|ォ+)/g,"");//safariを考慮して否定語後よみは使わない
	let replaced_text = text.replace(/ー(ァ+|ィ+|ゥ+|ェ+|ォ+)/g,"ー");
	
	//同じ母音のカナの後ろの小文字母音を長音に
	replaced_text = replaced_text.replace(/[ァ-ヴ](ァ+|ィ+|ゥ+|ェ+|ォ+)/g,function(match){
		let res = match;
		let l2s = { "ア":"ァ", "イ":"ィ", "ウ":"ゥ", "エ":"ェ", "オ":"ォ" }
		//1文字目の母音が2文字目の小文字母音と対応していたら
		let first_vowel = charToVowel(match[0]);
		if(first_vowel in l2s && l2s[first_vowel] == match[1]){
			res = match[0]+"ー";
		}
		//エィやオゥも長音に変換したい場合はコメントを外す
		//else if(first_vowel == "エ" && match[1] == "ィ"){
		//	res = match[0] + "ー";
		//}else if(first_vowel == "オ" && match[1] == "ゥ"){
		//	res = match[0] + "ー";
		//}
		//上記以外の小文字母音の連続に対応(これがないと「ヴァァァ」の「ァァァ」などが残り続ける
		else if(match.length>=3){
			res = match[0]+match[1]+"ー";
		}
		return res;
	});	
	return replaced_text;
}


//2文字カナの一部でない小文字(ッを除く)を大文字にする
//look-behindなのでsafariでは使えない
function smallVowelToLarge_lookbehind(text){
	
	//後よみはsafariで使えないので注意
	let re_ao = "(?<![ウクスツヌフムユルグズヅブプヴ])[ァヮォ]";//ウ段の後ろ以外のァヮェォ
	let re_u = "(?<![トド])ゥ";
	let re_y = "(?<![キシチニヒミリギジヂビピテデ])[ャュョ]";//イ段の後ろ以外のャュョ
	let re_i = "(?<![ウクスツヌフムユルグズヅブプヴテデ])ィ";//テデの後ろ以外のィ
	let re_e = "(?<![ウクスツヌフムユルグズヅブプヴイキシチニヒミリギジヂビピ])ェ";//ウ段、イ段の後ろ以外のェ
	
	let re = [re_ao,re_y,re_u,re_i,re_e].join("|");//上記のいずれかにマッチさせる
	
	let s2l = {"ァ":"ア","ィ":"イ","ゥ":"ウ","ェ":"エ","ォ":"オ","ヮ":"ワ","ャ":"ヤ","ュ":"ユ","ョ":"ヨ"}
	//マッチした小文字を大文字にして返す
	let replaced_text = text.replace(new RegExp(re,"g"),function(match){
		let large = s2l[match];
		return large;
	});
	return replaced_text;
}
//2文字カナの一部でない小文字(ッを除く)を大文字にする
//look-behindを使わない実装
function smallVowelToLarge(text){
	let s2l = {"ァ":"ア","ィ":"イ","ゥ":"ウ","ェ":"エ","ォ":"オ","ヮ":"ワ","ャ":"ヤ","ュ":"ユ","ョ":"ヨ"}
	//先頭以外の置換
	let replaced_text = text.replace(/.[ァィゥェォヮャュョ]/g, function(match){
		if(/[ウクスツヌフムユルグズヅブプヴ][ァヮォ]/.test(match)){//ウ段の後ろのァヮェォ
			return match;
		}else if(/[トド]ゥ/.test(match)){
			return match;
		}else if(/[キシチニヒミリギジヂビピテデ][ャュョ]/.test(match)){//イ段の後ろのャュョ
			return match;
		}else if(/[ウクスツヌフムユルグズヅブプヴテデ]ィ/.test(match)){//テデの後ろのィ
			return match;
		}else if(/[ウクスツヌフムユルグズヅブプヴイキシチニヒミリギジヂビピ]ェ/.test(match)){//ウ段、イ段の後ろのェ
			return match;
		}else{
			return match.replace(/[ァィゥェォヮャュョ]/,function(match){
				return s2l[match];
			});
		}
	})
	//先頭の置換
	replaced_text = replaced_text.replace(/^[ァィゥェォヮャュョ]/gm,function(match){
		return s2l[match];
	});
	return replaced_text;
}
//小書きカナ→大文字カナの対応(ひらがな・カタカナ両方)
const SMALL_TO_LARGE_KANA = {
	"ァ":"ア","ィ":"イ","ゥ":"ウ","ェ":"エ","ォ":"オ","ヮ":"ワ","ャ":"ヤ","ュ":"ユ","ョ":"ヨ",
	"ぁ":"あ","ぃ":"い","ぅ":"う","ぇ":"え","ぉ":"お","ゎ":"わ","ゃ":"や","ゅ":"ゆ","ょ":"よ",
};
//直前のカナと組み合わせて1モーラを構成する小書きカナの並び(カタカナ正規化後で判定)。
//KanaToSyllable().split が1ユニットとして切り出す組み合わせ(KanaPattern の multi)と
//同じ集合にしておくこと。ここで残した並びが split で分かれると単独の小書きが残る
const STICKY_SMALL_KANA_PATTERNS = [
	/^[ウクスツヌフムユルグズヅブプヴ][ァィェォ]$/,//ファ・ウィ・フェ・フォ など
	/^[テデ][ャィュョ]$/,                          //ティ・ディ・テュ など
	/^[イキシチニヒミリギジヂビピ][ャュョ]$/,      //拗音(キャ・シュ・ニョ など)
	/^[キシチニヒミリギジヂビピ]ェ$/,              //シェ・チェ・ジェ など
	/^[トド]ゥ$/,                                  //トゥ・ドゥ
];
//直前のカナと組み合わせて1モーラにならない小書きカナを大文字に直す
//「ハァ」「ウッセェ」「リィ」のような引き伸ばし表記や、単独で現れた小書きが対象。
//置換は必ず1文字→1文字で文字列長を変えないので、読みと表層の位置対応
//(char_index / mora)を使う呼び出し元を壊さない。促音ッ・長音ーには触らない
function absorbSmallKana(text){
	if(typeof text !== "string" || text.length === 0)return text;
	const chars = [];
	for(let i=0;i<text.length;i++){
		const c = text[i];
		const large = SMALL_TO_LARGE_KANA[c];
		if(!large){
			chars.push(c);
			continue;
		}
		//直前の文字は正規化後のものを見る(「スゥィ」→「スウィ」のように、
		//大文字化した結果くっつけられるようになる並びを拾うため)
		const prev = (i > 0) ? hiraToKata(chars[i-1]) : "";
		const pair = prev + hiraToKata(c);
		const sticky = STICKY_SMALL_KANA_PATTERNS.some(re=>re.test(pair));
		chars.push(sticky ? c : large);
	}
	return chars.join("");
}

//ーとッの不自然な並びを削除する
function removeBarAndSokuonReputation(text){
	text = text.replace(/ー+/g,"ー");//ーの連続を1文字にする
	//text = text.replace(/(?<=ッ)[ーッ]+/g,"");//後よみは使わないッの後ろのーまたはッの連続を削除
	text = text.replace(/ッ[ーッ]+/g,"ッ");//ッの後ろのーまたはッの連続を削除
	text = text.replace(/^[ーッ]+/g,"")//先頭の[ーッ]を削除
	return text;
}
//小文字や長音、促音の不自然な並びを解消する
function removeUnnaturalKanaPattern(text){
	text = smallVowelToBar(text);
	text = smallVowelToLarge(text);
	text = removeBarAndSokuonReputation(text);
	return text;
}


//入力カナをモウラの単位で分かち書きする。
function moraSplit(text){
	let re = /[ウクスツヌフムユルグズヅブプ][ァヮィェォ]|[キシチニヒミリギジヂビピテデ][ャュョ]|[イキシチニヒミリギジヂビピ]ェ|[テデ]ィ|[トド]ゥ|[ァ-ヴー]/g;
	text = text.match(re);
	return text;
}
function KanaToMora(){
	let re = /[ウクスツヌフムユルグズヅブプ][ァヮィェォ]|[キシチニヒミリギジヂビピテデ][ャュョ]|[イキシチニヒミリギジヂビピ]ェ|[テデ]ィ|[トド]ゥ|[ァ-ヴー]/g;
	return {
		split: function(text){
			return text.match(re);			
		}
	}
}

function KanaToSyllable(){
	//よく使うカナパターンの取得
	let kana = KanaPattern();
	//ーンッを前のカナとつなげるときのパターン
	let re2 = "ーッ|ンッ|ーン(?![ーッ])";//ーンは後ろにーッが来るとき以外
	let re1 = "ー|ッ|ン(?!ー)";//ンは後ろに長音が来るとき以外
	let re_back = "("+[re2,re1].join("|")+")";

	//長いものからマッチする
	//２文字カナとーンッのマッチ
	let re_multi_bar = "("+kana["multi"] + re_back + ")";

	//2文字カナと母音のマッチ
	let re_multi_a = kana["multi_a"]+"ア";
	let re_multi_i = kana["multi_i"]+"イ(?![ェ])";
	let re_multi_u = kana["multi_u"]+"ウ(?![ァィェォ])";
	let re_multi_e = kana["multi_e"]+"[エイ]";
	let re_multi_o = kana["multi_o"]+"(オ|ウ(?![ァィェォ]))";
	let re_multi_vowel = "("+[re_multi_a,re_multi_i,re_multi_u,re_multi_e,re_multi_o].join("|")+")";
	re_multi_vowel += "(?![ーンッ])";
	
	//２文字カナ単独のマッチ
	let re_multi_unit = kana["multi"];
	
	//ンとーッのマッチ
	let re_n_bar = "ン([ーッ]|ーッ)";
	
	//１文字カナとーッンのマッチ
	let re_single_bar = "("+kana["single_base"]+re_back+")";

	//１文字カナと母音のマッチ
	let re_single_a = kana["single_a"]+"ア";
	let re_single_i = kana["single_i"]+"イ";
	let re_single_u = kana["single_u"]+"ウ(?![ァィェォ])";
	let re_single_e = kana["single_e"]+"[エイ]";
	let re_single_o = kana["single_o"]+"(オ|ウ(?![ァィェォ]))";
	let re_single_vowel = "("+[re_single_a,re_single_i,re_single_u,re_single_e,re_single_o].join("|")+")";
	//1文字カナ単独のマッチ
	re_single_vowel += "(?![ーンッ])";

	let re_single_unit = "[ァ-ヴー]";
	//上記で定義した条件のオアをとる
	let re_all = [re_multi_bar, re_multi_vowel, re_multi_unit, re_n_bar, re_single_bar, re_single_vowel, re_single_unit].join("|");
	re_all = new RegExp(re_all, "g");
	
	//２文字以上で１シラブルの組み合わせ
	let re_multi_kana_full = [re_multi_bar, re_multi_vowel, re_multi_unit, re_n_bar, re_single_bar, re_single_vowel].join("|");
	re_multi_kana_full = "^("+re_multi_kana_full+")$";
	re_multi_kana_full = new RegExp(re_multi_kana_full);
	
	return {
		isFullmatch: function(text){
			return re_multi_kana_full.test(text);
		},
		split: function(text){
			return text.match(re_all);
		},
		//カナの発音のバリエーションを取得する
		//各変種に変換操作回数(コスト)を付与する(#105)。ン→ー化・ッ削除・
		//裸ン/ッ削除・ー削除=各1操作、複合音節は合計、無変換や表記ゆれ(母音連続→ー)=0。
		//返り値は従来同様のユニット配列(文字列配列)だが、各配列に .vcost プロパティで
		//操作回数の合計を持たせる。variation の各要素は {u:ユニット配列, c:操作数}。
		//さらに .srcIndex プロパティで「各出力ユニットが入力syllablesの何番目に由来するか」を
		//持たせる(ユニット位置別の重み付けスコアリング用。ン/ッ/ーの変種はユニット数が
		//変わるため、位置の対応づけにはこの由来indexが要る)。
		getVariation: function(syllables){
			//console.log("syllable",syllables);
			let result = [];
			//result[k] が syllables の何番目に由来するか(null音節はスキップされ添字がずれる)
			let resultSrc = [];
			if(!syllables)return [];
			for(let si=0; si<syllables.length; si++){
				const syllable = syllables[si];
				if(syllable === null) continue;
				let variation = [];
				if(/^[アイウエオ]$/.test(syllable)){//アイウエオは先に処理しておく
					variation.push({u:[syllable],c:0});
				}else if(/^[ンッ]$/.test(syllable)){
					variation.push({u:[syllable],c:0});
					variation.push({u:[""],c:1});//裸ン・ッの削除
				}else if(syllable == "ンー"){//ンー→["ン","ン"],["ン"],[""]
					variation.push({u:["ン","ン"],c:1});//ー→ン変換
					variation.push({u:["ン"],c:1});//ー削除
					variation.push({u:[""],c:2});//ン削除+ー削除
				}else if(syllable == "ンッ"){//ンッ→["ン","ッ"],["ン"],["ッ"],[""]
					variation.push({u:["ン","ッ"],c:0});
					variation.push({u:["ン"],c:1});//ッ削除
					variation.push({u:["ッ"],c:1});//ン削除
					variation.push({u:[""],c:2});
				}else if(syllable.endsWith("ーン")){//ex: アーン→["アー","ン"],["アー"]
					let head = syllable.slice(0,-2);
					variation.push({u:[head+"ー","ン"],c:0});
					variation.push({u:[head+"ー"],c:1});//ン削除
				}else if(syllable.endsWith("ンッ")){//ex: アンッ→["ア","ン","ッ"],["ア","ン"],["アー","ッ"],["アー"],["ア","ッ"]
					let head = syllable.slice(0,-2);
					variation.push({u:[head,"ン","ッ"],c:0});
					variation.push({u:[head,"ン"],c:1});//ッ削除
					variation.push({u:[head+"ー","ッ"],c:1});//ン→ー化
					variation.push({u:[head+"ー"],c:2});//ン→ー化+ッ削除
					variation.push({u:[head,"ッ"],c:1});//ン削除
				}else if(syllable.endsWith("ーッ")){//ex. アーッ→["アー","ッ"],["アー"]
					let head = syllable.slice(0,-2);
					variation.push({u:[head+"ー","ッ"],c:0});
					variation.push({u:[head+"ー"],c:1});//ッ削除
				}else if(syllable.endsWith("ー")){//ex. アー→["アー"]
					let head = syllable.slice(0,-1);
					variation.push({u:[head+"ー"],c:0});
				}else if(syllable.endsWith("ッ")){
					let head = syllable.slice(0,-1);
					variation.push({u:[head,"ッ"],c:0});//ex. アッ→["ア","ッ"],["ア"],["アー"]
					variation.push({u:[head],c:1});//ッ削除
					variation.push({u:[head+"ー"],c:1});//ッ→ー置換(単一操作でッ↔ーを閉じる)
				}else if(syllable.endsWith("ン")){//ex. アン→["ア","ン"],["アー"],["ア"]
					let head = syllable.slice(0,-1);
					variation.push({u:[head,"ン"],c:0});
					variation.push({u:[head+"ー"],c:1});//ン→ー化
					variation.push({u:[head],c:1});//ン削除(単一操作でン削除を閉じる)
				}
				//母音で終わる
				else if(/[アイウエオ]$/.test(syllable)){//カア→["カ","ア"],["カー"]
					let head = syllable.slice(0,-1);
					let vowel = syllable[syllable.length-1];
					variation.push({u:[head,vowel],c:0});
					variation.push({u:[head+"ー"],c:0});//表記ゆれ(母音連続→ー)扱いで無コスト
				}
				//1モーラ
				else{
					variation.push({u:[syllable],c:0});
				}
				result.push(variation);
				resultSrc.push(si);
			}
			return product(...result)
					.map(v => {
						//v.flatMap(o=>o.u).filter(v2=>v2!=="") と同じ結果を作りつつ、
						//残ったユニットごとの由来index(srcIndex)も同時に組み立てる
						const arr = [];
						const src = [];
						for(let k=0;k<v.length;k++){
							for(const u of v[k].u){
								if(u === "") continue;
								arr.push(u);
								src.push(resultSrc[k]);
							}
						}
						arr.vcost = v.reduce((s,o)=>s+o.c,0);//操作回数の合計
						arr.srcIndex = src;//各出力ユニットの由来音節index
						return arr;
					})
					.filter(v => v.length != 0);//長さ0の配列は要素に含めない
		}
	}
}

function getKanaToVowelDictionary (kana2phonon_dictionary) {
	const k2r = kana2phonon_dictionary;
	const roma2vowel = zip("aiueo","アイウエオ").reduce((prev,[v1,v2])=>{
		prev[v1] = v2;//aをアに変換する
		return prev;
	},{})
	;
	roma2vowel["p"]="sp";//無音
	roma2vowel["N"]="sp";//撥音の母音は無音とする
	roma2vowel["q"]="sp";//促音の母音は無音とする
	return Object.keys(k2r).reduce((prev,kana)=>{
		const romaVowelOfKana = k2r[kana][1].slice(-1);//kanaのローマ字表記の最後の文字(=母音)を取得
		prev[kana] = roma2vowel[romaVowelOfKana];//kanaを母音カナに変換
		//足してみた20190818
		if("ンッ".includes(kana)){

		}
		else if(kana == "sp"){

		}
		else{
			prev[kana+"ー"] = prev[kana];
			if(prev[kana] == "エ")
				prev[kana+"イ"] = prev[kana];
			else if(prev[kana] == "オ")
				prev[kana+"ウ"] = prev[kana];
		}

		return prev;
	},{});

}
//phononの単位でsplitする
//ン、ッは１単位。ーと母音だけ直前カナと１単位とみなす
function phononSplit(text){
	//よく使うカナパターンの取得
	let kana = getKanaPattern();

	//長いものからマッチする
	//２文字カナとーのマッチ
	let re_multi_bar = "("+kana["multi"]+ "ー)";

	//2文字カナと母音のマッチ
	let re_multi_a = kana["multi_a"]+"ア";
	let re_multi_i = kana["multi_i"]+"イ(?![ェ])";
	let re_multi_u = kana["multi_u"]+"ウ(?![ァィェォ])";
	let re_multi_e = kana["multi_e"]+"[エイ]";
	let re_multi_o = kana["multi_o"]+"(オ|ウ(?![ァィェォ]))";
	let re_multi_vowel = "("+[re_multi_a,re_multi_i,re_multi_u,re_multi_e,re_multi_o].join("|")+")";
	re_multi_vowel += "(?!ー)";
	
	//２文字カナ単独のマッチ
	let re_multi_unit = kana["multi"];
	
	//ンとーッのマッチ
	let re_n_bar = "ンー";
	
	//１文字カナとーッンのマッチ
	let re_single_bar = "("+kana["single_base"]+"ー)";

	//１文字カナと母音のマッチ
	let re_single_a = kana["single_a"]+"ア";
	let re_single_i = kana["single_i"]+"イ";
	let re_single_u = kana["single_u"]+"ウ(?![ァィェォ])";
	let re_single_e = kana["single_e"]+"[エイ]";
	let re_single_o = kana["single_o"]+"(オ|ウ(?![ァィェォ]))";
	let re_single_vowel = "("+[re_single_a,re_single_i,re_single_u,re_single_e,re_single_o].join("|")+")";
	//1文字カナ単独のマッチ
	re_single_vowel += "(?!ー)";

	let re_single_unit = "[ァ-ヴー]";
	//上記で定義した条件のオアをとる
	let re = [re_multi_bar, re_multi_vowel, re_multi_unit, re_n_bar, re_single_bar, re_single_vowel, re_single_unit].join("|");
	
	//matchで抽出
	text = text.match(new RegExp(re,"g"));

	return text;
}

const createKanaConverter = (KANA2PHONON_)=>{
	const k2s = KanaToSyllable();
	
	const KANA2VOWEL_ = getKanaToVowelDictionary(KANA2PHONON_);
	console.log(KANA2VOWEL_);
	//this.getKana2Vowel(this.KANA2PHONON_);
	console.log("KanaConverter",KANA2VOWEL_);
	//this.KANA2CONSONANT_ = this.getKana2Consonant(this.KANA2PHONON_);
	const KANA2CONSONANT_ = (()=>{
		const k2r = KANA2PHONON_;

		return Object.keys(k2r).reduce( (prev,kana) => {
			const romaConsonantOfKana = (k2r[kana][0] == "sp") ? "sp" : k2r[kana][0][0];
			switch(romaConsonantOfKana){
			case "c": prev[kana]="t";//cはtと同じ子音とする
			case "f": prev[kana]="h";//fはhと同じ子音とする
			case "j": prev[kana]="z";//jはzと同じ子音とする
			case "v": prev[kana]="b";//vはbと同じ子音とする
			default: prev[kana]=romaConsonantOfKana;
			}
			return prev;
		},{} );
		
	})();
	//this.KANA_UNITS_ = this.getKanaUnits(this.KANA2PHONON_,this.KANA2VOWEL_);
	const KANA_UNITS_ = (()=>{
		const k2r = KANA2PHONON_,
		k2v = KANA2VOWEL_;
		return Object.keys(k2r).reduce((prev,kana)=>{
			const vowelOfKana = k2v[kana];
			prev[kana] = [[kana]];
			switch(kana){
			case "ン": case "ッ":
				prev[kana].push([""]);
				break;
			}
			switch(vowelOfKana){
			case "ア": case "イ": case "ウ":	case "エ": case "オ":
				prev[kana+"ー"] = [[kana+"ー"]];//伸ばし棒のユニットを追加する
				prev[kana+"ン"] = [[kana+"ン"]];//ンのユニットを追加する
				prev[kana+"ッ"] = [[kana+"ッ"]];//ッのユニットを追加する
				prev[kana+vowelOfKana] = [[kana+"ー"],[kana,vowelOfKana]];//母音の連続を伸ばし棒化する
				if(vowelOfKana == "エ") prev[kana+"イ"] = [[kana+"ー"],[kana,"イ"]];//eiを伸ばし棒化する
				if(vowelOfKana == "オ") prev[kana+"ウ"] = [[kana+"ー"],[kana,"ウ"]];//ouを伸ばし棒化する
				break;
			}
			return prev;
		},{});
		
	})();
	const KANA_UNITS_LIST_ = Object.keys(KANA_UNITS_);

	const VOWELS_ = ["ア","イ","ウ","エ","オ"];
	
	
	const SmallManager = (()=>{
		const SMALL_VOWELS_ = "ァィゥェォャュョヮ";
		const LARGE_VOWELS_ = "アイウエオヤユヨワ";
		const SMALL2LARGE_ = (()=>{
			const obj = {}
			for(let i=0;i<SMALL_VOWELS_.length;i++)obj[SMALL_VOWELS_[i]]=LARGE_VOWELS_[i];
			return obj;
		})();
		const s2l = text => (text in SMALL2LARGE_)?SMALL2LARGE_[text]:null;
		
		const canStick = (t1,t2) => {	
			return t2 in SMALL2LARGE_ && (t1+t2) in KANA2PHONON_;
		}
		const stick = ary => {
			if(ary.length < 2)return ary;
			const newary = [ary[0]]
			for(let i=1;i<ary.length;i++){
				if(canStick(newary[newary.length-1]),ary[i])newary[newary.length-1]+=ary[i];
				else newary.push(ary[i]);
			}
			return newary;
		}
		const enlargeHead = text => {
			if(text.length < 1)return text;
			if(text[0] in SMALL2LARGE_){
				const l = SMALL2LARGE_[text[0]]
				if(text.length == 1)return l;
				else return l+text.slice(1);
			}
			else return text;
		}
		return {
			getS2L: ()=> SMALL2LARGE_,
			s2l: s2l,
			stick: stick,
			enlargeHead: enlargeHead
		}

	})();
	
	const separate = kanaStr => {
		return syllableSplit(kanaStr);
		const LEN_MAX_ = 2;
		//const KANA_UNITS_ = KanaConverter.getKanaUnits();
		const K2V = KANA2VOWEL_;
		
		let result = [],
			i=0;
		kanaStr = kanaStr.replace(/ーー/g, "ー").replace(/ンン/g, "ン").replace(/ッッ/,"ッ");
		let kanaStrLen = kanaStr.length;
		kanaStr += "//";
		//console.log('kanaStr',kanaStr);
		while(i<kanaStrLen){
			let p = kanaStr.slice(i,i+LEN_MAX_+1);
			//if(p[0] in S2L){
			//	p = S2L[p[0]] + p.slice(1);
			//}
			p = KanaConverter.enlargeHead(p);
			let moji = "";
			for(let si = LEN_MAX_; si>0; si--){
				let p1 = p.slice(0,si);
				let p2 = p[si];
				if(p1 in K2V){
					if(p2 == "ー"){
						if(K2V[p1] == "エ" && p1[p1.length-1] == "イ")
							moji = p1[0];
						else if(K2V[p1] == "オ" && p1[p1.length-1] == "ウ"){
							moji = p1[0];
						}
						else if(p1 == "ン"){
							result.push(p1);
							i += 1;
							moji = p1;
						}
						else{
							moji = p1+p2;
						}
					}
					else if(p2 == "エ" && K2V[p1] == "エ" && p1[p1.length-1] == "イ")
						moji = p1;
					else if(p2 == "オ" && K2V[p1] == "オ" && p1[p1.length-1] == "ウ")
						moji = p1;
					else if("アイウエオ".includes(p2) && K2V[p1] == p2 && p1[p1.length-1] != "ー")
						moji = p1 + p2;
					else
						moji = p1;
					break;
				}
			}
			if(moji == "")
				break;
			result.push(moji);
			i+=result[result.length-1].length;
		}
		//p = kanaStr.slice(kanaStrLen);
		return result;
	}
	//母音連続時の変換パターンのリスト("アア"を[["アー"],["ア","ア"]]にするなど)
	const getPronunciationVariation2 = (kana) => {
		return getPronunciationVariation(kana);
		const kanaUnits = KANA_UNITS_;
		const variations = kana.map(v => {
			//if(Object.keys(kanaUnits).indexOf(v)>=0)
			if(v in kanaUnits)
				return kanaUnits[v];
			else
				return [v];
		});
		return product(...variations)
				.map(v => v.filter(v2=>v2!="").flat())
				.filter(v => v.length != 0);//長さ0の配列は要素に含めない
	}



	return {
		//s2l: SmallManager.s2l,
		//getS2L: SmallManager.getS2L,
		//getKanaUnits: ()=>KANA_UNITS_,
		//getK2V: ()=>KANA2VOWEL_,
		//enlargeHead: SmallManager.enlargeHead,
		separate: k2s.split,
		//getKana2Phonon: ()=>KANA2PHONON_,
		getPronunciationVariation: k2s.getVariation,
		//hiraToKana: hiraToKata,
		isSameKana: isSameKana,
		isSameVowel: isSameVowel,
		isSameConsonant: isSameConsonant,
		isSameBar: isSameBar,
		isSameHatsuon: isSameHatsuon,
		isSameSokuon: isSameSokuon
	}

};

export {
	barToVowel, vowelToBar, charToConsonant, charToVowel,
	isSameKana, isSameVowel, isSameConsonant, isSameBar, isSameSokuon, isSameHatsuon,
	hiraToKata, KanaPattern, smallVowelToBar, smallVowelToLarge,
	removeBarAndSokuonReputation, removeUnnaturalKanaPattern, absorbSmallKana,
	moraSplit, KanaToMora, KanaToSyllable, getKanaToVowelDictionary,
	phononSplit, createKanaConverter,
};
