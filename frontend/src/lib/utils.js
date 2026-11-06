// js/utils.js から移植(ロジック無改変、ESモジュール化のみ)

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
	return strVal;
}

export { zip, product, removeSign };
