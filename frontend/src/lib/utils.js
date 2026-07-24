// js/utils.js から移植(ロジック無改変、ESモジュール化のみ)

//const zip = (array1, array2) => array1.map((_, i) => [array1[i], array2[i]]);
//const zip = (...rows) => rows[0].map((_,c)=>rows.map(row=>row[c]));
const zip = (...rows) => [].map.call(rows[0],(_,c)=>rows.map(row=>row[c]));



//直積を求めてリストで返す
const product = (...args) => {
	if (args.length == 0) return [];//
    let prod = args[0].map(m => [m]);
    for (let i = 1; i<args.length; i++){
    	prod = prod.map( m =>
    		args[i].map( n => [...m,n])
    	).flat();
    }
    return prod;
}




//a=[["オ","オ"],["オー"]];
//b=[["エ","エ"],["エー"]];
//c=[["ウ","ウ"],[]];
//console.log(product(a,b,c));


const orgRound = (value, base) => Math.round(value * base) / base;

const getRandomText = (num=8) => {
	var l = num;//生成する文字列の長さ
	var c = "abcdefghijklmnopqrstuvwxyz0123456789";

	var cl = c.length;
	var r = "";
	for(var i=0; i<l; i++){
	  r += c[Math.floor(Math.random()*cl)];
	}

	return r;
}


//makeKanaDist時のデフォルトパラメータを作る関数
const setDefaultParameters = (param={}) => {
	let defaultParam = {
	        "splitter":"/",
	        "vowel":1,
	        "consonant":1,
	        "repeat":100,
	        "duplicate":false,
	        "bunsetsu": 1,
	        "wordsNum":1,
	        "sameChar":1,
	        "sameVowel":1,
	        "sameConsonant":1,
	        "length":1
	}
	return Object.assign(defaultParam,param);
}



/**
 * 全角から半角への変革関数
 * 入力値の英数記号を半角変換して返却
 * [引数]   strVal: 入力値
 * [返却値] String(): 半角変換された文字列
 */
const toHalfWidth = (strVal) => {
  // 半角変換
  let halfVal;
  halfVal = strVal.replace(/[！-～]/g,
    function( tmpStr ) {
      // 文字コードをシフト
      return String.fromCharCode( tmpStr.charCodeAt(0) - 0xFEE0 );
    }
  );

  // 文字コードシフトで対応できない文字の変換
  return halfVal.replace(/”/g, "\"")
    .replace(/’/g, "'")
    .replace(/‘/g, "`")
    .replace(/￥/g, "\\")
    .replace(/　/g, " ")
    .replace(/〜/g, "~");
}

const removeSign = strVal => {
	strVal = toHalfWidth(strVal); //全角を半角に変換
	strVal = strVal.replace(/\W/g, m=>{return m.match(/[!-~]|\s/) ? "" : m}); //正規表現で記号を削除
	strVal = strVal.replace(/・/g, '').replace(/「/g, '').replace(/」/g, '');
	strVal = strVal.replace(/。/g, '').replace(/、/g, '');
	//console.log("check");
	return strVal;
}

const toKatakana = strVal => {
	strVal.replace(/[ぁ-ん]/g, function(s) {
		   return String.fromCharCode(s.charCodeAt(0) + 0x60);
	});
}

const formatText = strVal => {
	strVal = removeSign(strVal);
	strVal = toKatakana(strVal);
	return strVal;
}



function argsort(array) {
    const arrayObject = array.map((value, idx) => { return { value, idx }; });
    arrayObject.sort((a, b) => {
        if (a.value < b.value) {
            return -1;
        }
        if (a.value > b.value) {
            return 1;
        }
        return 0;
    });
    const argIndices = arrayObject.map(data => data.idx);
    return argIndices;
}
const argmin = array => [].map.call(array, (x, i) => [x, i]).reduce((r, a) => (a[0] < r[0] ? a : r))[1];

function containAlphabet(val){
	console.log("containAlphabet",val);
	var regex = /^[^\x01-\x7E\xA1-\xDF]+$/
	return !regex.test(val);
}


export {
	zip, product, orgRound, getRandomText, setDefaultParameters,
	toHalfWidth, removeSign, toKatakana, formatText,
	argsort, argmin, containAlphabet,
};
