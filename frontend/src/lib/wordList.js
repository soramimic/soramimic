// js/WordList.js から移植(ロジック無改変、ESモジュール化のみ)
function Parser(){
	function tokenize(query_str){
		//query_str = query_str.replace(/(?<!!)=|!=|\(|\)/g," $& ");//後よみは使わない
		//長い演算子から順にマッチさせる(!~= / ~= / != / =)
		query_str = query_str.replace(/!~=|~=|!=|=|\(|\)/g," $& ");//!~= or ~= or != or = or ( or )
		query_str = query_str.trim();
		return query_str.split(/\s+/);
	}
	
	//[結果, 消費した次のインデックス] を返す。エラー時は -1。
	//閉じ括弧 ")" に当たったら消費せずにループを抜け、呼び出し側(factor)に委ねる。
	function expression(obj, query, i, checkFunc){
		//console.log("exp",checkFunc);
		if(i>=query.length)return -1;

		let result;
		let r = factor(obj, query, i, checkFunc);

		if(r === -1)return -1;

		result = r[0];
		i = r[1];

		while(i < query.length){
			if(query[i] === ")")break;
			if(query[i] !== "or" && query[i] !== "and")return -1;

			let r = factor(obj, query, i+1, checkFunc);

			if(r === -1)return -1;

			if(query[i] === "or"){
				result = (result || r[0]);
			}else{
				result = (result && r[0]);
			}

			i = r[1];
		}

		return [result, i];
	}

	function factor(obj, query, i, checkFunc){
		//console.log("checkFunc",checkFunc);
		if(query[i] === "("){
			let r = expression(obj, query, i+1, checkFunc);
			if(r === -1)return -1;
			if(query[r[1]] === ")"){
				return [r[0], r[1]+1];
			}else{
				return -1;
			}
		}else if(i < query.length-2 && (query[i+1] === "=" || query[i+1] === "!=" || query[i+1] === "~=" || query[i+1] === "!~=")){
			let r = checkFunc(query, i, obj);
			if(r === -1)return -1;
			return [r, i+3];
		}else{
			return -1;
		}
	}
	
	function getKeys(query){
		let result = [];
		for(let i=1;i<query.length-1;i++){
			if(query[i] === "=" || query[i] === "!=" || query[i] === "~=" || query[i] === "!~="){
				if(result.includes(query[i-1])===false){
					result.push(query[i-1]);
				}
			}
		}
		return result;
	}

	return {
		eval: function(query_str, obj){
			let query = tokenize(query_str);
			//console.log(query);
			let result = expression(obj,query,0, function(query, i, obj){
				//console.log(query[i+1]);
				if(query[i+1] === "="){
					return obj[query[i]] === query[i+2];
				}else if(query[i+1] === "!="){
					return obj[query[i]] !== query[i+2];
				}else if(query[i+1] === "~="){
					return (obj[query[i]] ?? "").includes(query[i+2]);
				}else if(query[i+1] === "!~="){
					return !(obj[query[i]] ?? "").includes(query[i+2]);
				}else{
					return -1;
				}
			});
			return result === -1 ? -1 : result[0];
		},
		filter: function(query_str, header, dataframe){
			let query = tokenize(query_str);
			let keys = getKeys(query);
			let keyToIndex = {}
			for(let k of keys){
				let index = header.indexOf(k);
				if(index == -1){
					console.log("error");
					return false;
				}
				keyToIndex[k] = index;
			}
			let checkFunc = function(query, i, obj){
				if(query[i+1] === "="){
					let index = keyToIndex[query[i]];
					return obj[index] === query[i+2];
				}else if(query[i+1] === "!="){
					let index = keyToIndex[query[i]];
					return obj[index] !== query[i+2];
				}else if(query[i+1] === "~="){
					let index = keyToIndex[query[i]];
					return (obj[index] ?? "").includes(query[i+2]);
				}else if(query[i+1] === "!~="){
					let index = keyToIndex[query[i]];
					return !(obj[index] ?? "").includes(query[i+2]);
				}else{
					return -1;
				}
			}
			let result = dataframe.filter(obj=>{
				let r = expression(obj, query, 0, checkFunc);
				return r !== -1 && r[0];
			});
			return result;
		}
	}
}
		
function WordList(textAnalyzer){
	const WORD_LIST_ = {}
	const YIELD_BATCH_SIZE = 256;

	// 大きなワードリストの読み込み中も、ブラウザが描画や入力を処理できる
	// ように定期的にイベントループへ制御を返す。
	function yieldToBrowser(){
		return new Promise(resolve => setTimeout(resolve, 0));
	}

	
	async function loadDatabaseCsvText(text, query_str, maxUnits){
		//console.log("loadDatabaseCsvText",text);
		//let text = loadTextFileSync(path);
		// 改行を含む \s を使うと、末尾カラムが空の行(行末が ",")が次行を飲み込む
		text = text.replace(/[ \t]*,[ \t]*/g,",");
		let lines = text.split(/\r\n|\n|\r/);
		let header = lines[0].split(",");
		let df = [];
		for(let i=1;i<lines.length;i++){
			let row = lines[i].split(",");
			// 末尾改行や途中の空行はCSVレコードとして扱わない
			if(row.some(v=>v.trim() !== "")) df.push(row);
		}
		
		let parser = Parser();
		
		let filterred_df;
		if(query_str) filterred_df = parser.filter(query_str,header,df);
		else filterred_df = df;
		
		const h2i = {}
		for(let i=0;i<header.length;i++){
			h2i[header[i]] = i;
		}
		let pronunciations = filterred_df.map((v,)=>{
			let p = v[h2i["pronunciation"]];
			if(!p || p==="NA" || p==="na"){
				p = v[h2i["surface"]];
			}
			return p;
		});
		let pronunciations2;
		console.time("non,mecab")
		//kanjiがあるときだけtokenizerにかける
		
		let kanji_pronunciation = []
		let kanji_pronunciation_id = [];
		for(let i=0;i<pronunciations.length;i++){
			let p = pronunciations[i]
			if(/[一-龠]/.test(p)){
				kanji_pronunciation.push(p);
				kanji_pronunciation_id.push(i);
			}
		}
		console.log("kanji_pronunciation",kanji_pronunciation);
		
		if(kanji_pronunciation.length > 0){
			for(let start=0;start<kanji_pronunciation.length;start+=YIELD_BATCH_SIZE){
				let end = Math.min(start + YIELD_BATCH_SIZE, kanji_pronunciation.length);
				let yomi = textAnalyzer.getYomi(kanji_pronunciation.slice(start,end));
				for(let i=start;i<end;i++){
					let index = kanji_pronunciation_id[i];
					pronunciations[index]=yomi[i-start];
				}
				await yieldToBrowser();
			}
		}
		pronunciations2 = new Array(pronunciations.length);
		for(let i=0;i<pronunciations.length;i++){
			pronunciations2[i] = textAnalyzer.formatKana(pronunciations[i]);
			if((i+1)%YIELD_BATCH_SIZE === 0) await yieldToBrowser();
		}
		console.timeEnd("non,mecab")
		//console.time("mecab2");
		//console.log("pronunciations",pronunciations);
		//pronunciations2 = textAnalyzer.getYomi(pronunciations);
		//console.timeEnd("mecab2")
		//console.time("mecab");
		//console.log("pronunciations",pronunciations);
		//pronunciations2 = textAnalyzer.tokenizeTogether(pronunciations);
		//pronunciations2 = pronunciations2.map(tokens=>textAnalyzer.getYomiFromTokens(tokens));
		//console.timeEnd("mecab")
		pronunciations = pronunciations2;
		//console.log("pronunciations",pronunciations);
				
		const resultdb = {}
		for(let i=0;i<filterred_df.length;i++){
			let line = filterred_df[i];
			let obj = {}
			//id, surface, original, pronunciationはある前提
			for(let i=0;i<header.length;i++){
				obj[header[i]]=line[i];
			}
			//if(!obj.pronunciation || /^NA$|^na$/.test(obj.pronunciation)){
			//	obj.pronunciation = textAnalyzer.getYomi(obj.surface);
			//}
			//surfaceから読みを推測してもなお空であればスキップ
			obj.pronunciation = pronunciations[i];
			if(!obj.pronunciation) continue;
			
			// maxUnits を変種生成まで渡し、長い読みの直積を作る途中で枝刈りする。
			const pvariations = textAnalyzer.yomiToVariation(obj.pronunciation, maxUnits);
			for(let p of pvariations){
				if(maxUnits !== undefined && p.length > maxUnits) continue;
				if(p.length in resultdb === false)resultdb[p.length]=[];
				resultdb[p.length].push({
					"surface":obj.surface,
					"pronunciation":p,
					"kana":obj.pronunciation,
					"id":obj.id,
					"original":obj.original,
					"vcost":p.vcost||0 //単語側の変種コスト(#105)
				});
			}
			if((i+1)%YIELD_BATCH_SIZE === 0) await yieldToBrowser();
		}
		return resultdb;
	} 
	
	
	function plainToCsv(text){
		let header = [["id","original","surface","pronunciation"]]
		let lines = text.split(/\r\n|\n/);
		lines = lines.map(v=>v.replace(/#.*$/,""));//#以降をコメントアウト
		lines = lines.map(v=>v.replace(/\u200B/g,""));//#エスケープ
		lines = lines.map(v=>v.split(","));//カンマでスプリット
		lines = lines.filter(v=>v.length > 0 && v[0]);//不正な行を削除
		let csvlines = []
		for(let i=0;i<lines.length;i++){
			let v = lines[i];
			//console.log(v);
			if(v.length === 1){
				csvlines.push([String(i),v[0],v[0],v[0]]);
			}else{
				//「見出し語,読み1,読み2…」: 1列目は original 兼 surface(表示に使う表記)、
				//2列目以降は読み(マッチングにだけ使う)。読みが複数あるときは
				//同じid・同じsurfaceの行が読みの数だけ並ぶ(tidy CSVと同じ構造)
				for(let j=1;j<v.length;j++){
					if(v[j]){
						csvlines.push([String(i),v[0],v[0],v[j]]);
					}
				}
			}
		}
		
		let db = header.concat(csvlines);
		//console.log(lines,csvlines,db);
		db = db.map(v=>v.join(",")).join("\n");
		return db;
	}
	

	const loadDatabaseText = async (text, maxUnits) => {
		let csvtext = plainToCsv(text);
		return loadDatabaseCsvText(csvtext, "", maxUnits);
		
		const words = text.split("\n").map(val=>{
			val = val.replace(/\u200B/g, "");//エスケープ処理
			val = val.split("#")[0].split(",");//各行において#以降をコメントアウトして、カンマでスプリット
			return val;
		}).filter(v => (v.length > 0 && v[0]));

		const resultdb = {}
		for(let i = 0; i<words.length;i++){
			const v = words[i];

			//if(v.length == 1)v.push(this.getYomi(v[0]));
			if(v.length == 1)v.push(textAnalyzer.getYomi(v[0]));
			const title = v[0];
			for(let v2 of v.slice(1)){
				if(v2.length == 0)console.log("v2",v2);
				//const yomi = textAnalyzer.getYomi(v2);
				//const sep = KanaConverter.separate(yomi);
				const ptn = textAnalyzer.textToVariation(v2);
				//if(v2 == "タンノ"){
				//	console.log("y9omi",yomi,sep,ptn);
				//}
				for(let v3 of ptn){
					const v3len = v3.length;
					if(!(v3len in resultdb))resultdb[v3len]=[]
					//resultdb[v3len].push([title,v2,v3,i]);
					resultdb[v3len].push({
						"surface":v2, 
						"kana":v2, 
						"pronunciation":v3,
						"id":String(i),
						"original":title
					});
				}
			}
		}
		return resultdb;
	}	
	
	
	const loadDatabaseTextWithMeCab = (text) => {
		const splitted_text = text.split('\n')
								.map(val=>{
									val = val.replace(/\u200B/g, "");//エスケープ処理
									val = val.split("#")[0]
									return val;
								});
		const words_yomi = getMeCabYomi(splitted_text.join('\n'));
		const words = words_yomi.split("\n").map(val=>{
			val = val.split(",");//カンマでスプリット
			return val;
		}).filter(v => (v.length != 0 && v[0] != ""));
		const words_org = splitted_text.map(v=>v.split(',')[0])
						.filter(v => (v.length != 0 && v[0] != ""));

		const resultdb = {}
		for(let i = 0; i<words.length;i++){
			const v = words[i];

			if(v.length == 1)v=[words_org[i],EnglishManager.toKana(v)];
			const title = words_org[i];
			for(let v2 of v.slice(1)){
				if(v2.length == 0)console.log("v2",v2);
				const yomi = EnglishManager.toKana(v2);
				//const sep = this.separateKana(yomi);
				const sep = kanaConverter.separate(yomi);
				const ptn = kanaConverter.textToVariation(sep);
				for(let v3 of ptn){
					const v3len = v3.length;
					if(!(v3len in resultdb))resultdb[v3len]=[]
					resultdb[v3len].push([title,v2,v3,i]);
				}
			}
		}
		return resultdb;
	}
	
	const setWordList = (key, text, config = {}) => {
		//const path = WORD_FILE_PATH_[k];
		//WORD_LIST_[key] = loadDatabaseFile(path);
		const dbtype = config.dbtype;
		if(dbtype === "plain"){
			WORD_LIST_[key] = loadDatabaseText(text);
		}else if(dbtype === "tidy"){
			WORD_LIST_[key] = loadDatabaseCsvText(text, config.where);
		}else{
			WORD_LIST_[key] = loadDatabaseText(text);			
		}
		
		//console.log(JSON.stringify(WORD_LIST_[key]));
	}
	

	return {
		//setOrg: setOrg,
		//set: setWordList,
		//setList: setList,
		parseTidy: loadDatabaseCsvText,
		parsePlain: loadDatabaseText,
		// plain形式 → tidy CSV の正規化。parsePlain が内部で通しているのと同じ関数を
		// そのまま公開しただけ(ロジック無改変)。自作リストのCSVを書き出しJSONへ
		// 同梱するのに使う(parseTidy(csv,"") は parsePlain(text) と同じDBになる)
		plainToCsv: plainToCsv,

		//setWordListFile: setWordListFile,
		//get: get,
		//exists: exists
	}
}
export { Parser, WordList };
