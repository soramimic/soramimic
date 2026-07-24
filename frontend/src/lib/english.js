// js/English.js から移植(ロジック無改変、ESモジュール化のみ)
//apostrophyの変換や削除を行う関数
function Apostrophe(){
	let STRING_APOSTROPHY = "APOSTROPHE";
	
	return {
		toString: function(text){
			//console.log("apostrophe",text);
			return text.split("’").join("'").split("'").join(STRING_APOSTROPHY);
		},
		toSign: function(text){
			return text.split(STRING_APOSTROPHY).join("'");
		},
		removeString: function(text){
			return text.split(STRING_APOSTROPHY).join('');
		},
		include: function(text){
			return text.include(STRING_APOSTROPHY);
		},
		format: function(text){
			return text.replace(/[’]/g,"'");
		}
	}
}

function English(DICTIONARY, TREE){
	const AP = Apostrophe();
	
	function zenkakuEnglishToHankaku(text){
		return text.replace(/[Ａ-Ｚａ-ｚ]/, s => String.fromCharCode(s.charCodeAt(0) - 65248)); // 全角→半角
	}
	function romanToKana(text, tree){
		let str = text.toLowerCase();
		let result = '';
		let tmp = '';
		let index = 0;
		const len = str.length;
		let node = tree;
		const push = (char, toRoot = true) => {
			result += char;
			tmp = '';
			node = toRoot ? tree : node;
		};
		while (index < len) {
			const char = str.charAt(index);
			if (char.match(/[a-z]/)) { // 英数字以外は考慮しない
				if (char in node) {
					const next = node[char];
					if (typeof next === 'string') {
						push(next);
					} else {
						tmp += text.charAt(index);
						node = next;
					}
					index++;
					continue;
				}
				const prev = str.charAt(index - 1);
				if (prev && (prev === 'n' || prev === char)) { // 促音やnへの対応
					push(prev === 'n' ? 'ン' : 'ッ', false);
				}
				if (node !== tree && char in tree) { // 今のノードがルート以外だった場合、仕切り直してチェックする
					push(tmp);
					continue;
				}
			}
			push(tmp + char);
			index++;
		}
		tmp = tmp.replace(/n$/, 'ン'); // 末尾のnは変換する
		push(tmp);
		return result;
	}

	//textが英単語だったら
	function englishWordToKana(text, dictionary){
		const e2k = dictionary;//英単語をカナに変換する辞書
		let upper = text.toUpperCase();//英語は大文字に直しておく
		if(upper in e2k)return e2k[upper];
		else return text;
	}

	//
	function alphabetToKana(text, dictionary){
		const e2k = dictionary;
		text = text.toUpperCase();
		let found = text.match(/[A-Z]/g);//iは大文字小文字無視。
		if(found){
			for(let v of found){
				text = text.split(v).join(e2k[v]);
			}		
		}
		return text;
	}
	//英単語のみの文字列を入力
	function englishToKana(text, dictionary, tree){
		text = zenkakuEnglishToHankaku(text);
		text = englishWordToKana(text, dictionary);
		text = romanToKana(text, tree);
		text = alphabetToKana(text, dictionary);
		return text;	
	}
	
	function isFullmatch(text){
		return /^[a-zA-Z']+$/.test(text);
	}
	
	function tokenize(text,tokenizer){
		const strVal = AP.toString(text);
		//tokenize
		let tokens = tokenizer.tokenize(strVal);
		//let tokens2 = JSON.parse(JSON.stringify(tokens));
		//console.log("english",tokens2);
		
		//surfaceの修正、pronunciationの代入
		tokens = tokens.map(token=>{
			if(isFullmatch(token.surface_form)){
				//console.log("english fullmatched");
				token.surface_form = AP.toSign(token.surface_form);
				if(token.pronunciation === "*"){
					token.pronunciation = englishToKana(token.surface_form, DICTIONARY, TREE);					
				}
			}
			return token;
		});
		//tokens2 = JSON.parse(JSON.stringify(tokens));
		//console.log("english",tokens2);
		
		return tokens;
	}
	
	
	return {
		toKana: function(text){
			return englishToKana(text, DICTIONARY, TREE)
		},
		tokenize: function(text, tokenizer){
			return tokenize(text, tokenizer);
		},
		apostrophe: AP,
		isFullmatch: isFullmatch,
	}
}
export { Apostrophe, English };
