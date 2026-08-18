// js/Character.js から移植(ロジック無改変、ESモジュール化のみ)
function TokenFormatter(){
	//ひらがなをカタカナに変換
	function hiraToKata (str) {
	    return str.replace(/[\u3041-\u3096]/g, function(match) {
	        var chr = match.charCodeAt(0) + 0x60;
	        return String.fromCharCode(chr);
	    });
	}
		
	function removeSignPronunciation(tokens){
		  //記号の処理
		  //発音を空文字にする
		  tokens = tokens.map(token=>{
			 if(token["pos"] === "記号"){
				 token["pronunciation"] = token["surface_form"];
			 } 
			 return token;
		  });
		  return tokens
	}
	function removeUnknownSahen(tokens){
		  //サ変接続の処理
		  //サ変接続で発音が定義されていなければ、posを記号にして発音を空文字にする
		  tokens = tokens.map(token=>{
			  if(token.pos === "名詞" && token.pos_detail_1 === "サ変接続" && !token.pronunciation){
				  token.pos = "記号";
				  token.pronunciation = "";
			  }
			 return token; 
		  });
		  
		  return tokens;
	}
	function isSmallKanaStart(char){
		return /^[ぁぃぅぇぉゃゅょゎっァィゥェォヮャュョッ]/.test(char);
	}
	function isKanaEnd(char){
		return /[ぁ-ゔァ-ヴ]$/.test(char);
	}
	function isKana(text){
		return /^[ぁ-ゔァ-ヴー]+$/.test(text);
	}
	
	
	function concatSmallKana(tokens){
		for(let i=1;i<tokens.length;i++){
			if(isSmallKanaStart(tokens[i].surface_form) && isKanaEnd(tokens[i-1].surface_form)){
				tokens[i-1].surface_form += tokens[i].surface_form;
				tokens[i-1].pronunciation += tokens[i].pronunciation;
				tokens[i].isRemove = true;
			}
		}
		tokens = tokens.filter(v=> !v.isRemove);
		return tokens;
	}
	//不明語の処理
	//不明語があれば表層系を発音とする	
	function setUnknownWordPronunciation(tokens){
		
		  tokens = tokens.map(token=>{
			  
			 if(token.word_type == "UNKNOWN" && isKana(token.surface_form)){
			  //if(includeKana(token.surface_form)){
				 token.pronunciation = hiraToKata(token.surface_form);
				 //if(token.pos === "記号")token.pos="名詞";
			 }
			 return token;
		  });
		  return tokens;
	}
	
	function setKanaPronunciation(tokens){
		tokens = tokens.map(token=>{
			if(isKana(token.surface_form)){
				 token.pronunciation = hiraToKata(token.surface_form);
				 if(token.pos === "記号")token.pos="名詞";
			}
			return token;
		});
		return tokens;
	}
	
	//長音の処理
	//単独のtokenがあれば、直前のtokenとくっつける
	function concatSingleBar(tokens){
		
		  for(let i=1;i<tokens.length;i++){
			  if(tokens[i]["surface_form"] === "ー"){
				  tokens[i-1]["surface_form"] += "ー";  
				  tokens[i-1]["pronunciation"] += "ー";
			  }
		  }
		  tokens = tokens.filter(token=>token["surface_form"] !== "ー");
		return tokens;
	}
	
	function setNumberPronunciation(tokens){
		let n2p = {"1":"イチ","2":"ニ","3":"サン","4":"ヨン","5":"ゴ","6":"ロク","7":"ナナ","8":"ハチ","9":"キュウ","0":"ゼロ"}
		tokens = tokens.map(token=>{
			// 複数桁も1トークンになる。仮読みは桁読みでよいので、まず編集可能な
			// 発音ユニットを作り、必要なら編集ツールで「12→ジュウニ」のように直す。
			if(/^[0-9]+$/.test(token.surface_form) &&
				!/^[ァ-ヴー]+$/.test(token.pronunciation || "")){
				let p = "";
				for(let v of token.surface_form){
					p += n2p[v];
				}
				token.pronunciation = p; 
			}
			return token;
		});
		return tokens;
	}
	
	function setPhraseIndex(tokens){
		let cnt = 0;
		tokens = tokens.map((token,index)=>{
			if(index === 0){
				token["phrase"] = 0;
				return token;
			}
			if(["名詞","動詞","副詞","形容詞","形容動詞","感動詞"].includes(token.pos)){
				cnt += 1;
			}
			token["phrase"] = cnt;
			return token;
		});
		return tokens;
	}
	
	function format(tokens){
	  //
	  //console.log(1,JSON.stringify(tokens));
	  tokens = removeSignPronunciation(tokens);
	  //console.log(2,JSON.stringify(tokens));
	  tokens = removeUnknownSahen(tokens);
	  //console.log(3,JSON.stringify(tokens));
	  tokens = setNumberPronunciation(tokens);
	  //console.log(4,JSON.stringify(tokens));
	  //tokens = setUnknownWordPronunciation(tokens);
	  tokens = setKanaPronunciation(tokens);
	  //console.log(5,JSON.stringify(tokens));
	  tokens = concatSingleBar(tokens);
	  tokens = concatSmallKana(tokens);
	  //console.log(6,JSON.stringify(tokens));
	  tokens = setPhraseIndex(tokens);
	  //console.log(7,JSON.stringify(tokens));
	  return tokens;
	}
	return {
		format: format
	}
}

function Kanji(dictionary, kanaToSyllable){
	//同じ辞書読みを語ごと・文字ごとに再分割しない。歌詞や大規模単語リストの
	//解析では同じ候補を多数回使うため、発音単位列だけを共有する。
	const dictionaryUnits = new Map();
	function splitDictionaryYomi(yomi){
	  if(!dictionaryUnits.has(yomi)){
	    dictionaryUnits.set(yomi, kanaToSyllable.split(yomi) || []);
	  }
	  return dictionaryUnits.get(yomi);
	}

	//読み候補は文字列ではなく発音単位列で照合する。「ジ」は一まとまりの
	//「ジュウ」内部には一致しないため、拗音・長音の途中をアンカーにしない。
	function findSyllableMatch(restText, yomiCandidates){
	  const restUnits = kanaToSyllable.split(restText) || [];
	  let best = null;
	  for(const yomi of yomiCandidates){
	    const yomiUnits = splitDictionaryYomi(yomi);
	    if(yomiUnits.length == 0) continue;
	    for(let i=0;i+yomiUnits.length<=restUnits.length;i++){
	      if(!yomiUnits.every((unit, j) => unit === restUnits[i+j])) continue;
	      if(best == null || i < best.unitStart){
	        best = { unitStart: i, yomi };
	      }
	      break;
	    }
	    //辞書候補は長い順。読みの先頭で一致した最初の候補を採ればよい。
	    if(best && best.unitStart === 0) break;
	  }
	  if(best == null) return null;
	  return {
	    start: restUnits.slice(0, best.unitStart).join("").length,
	    yomi: best.yomi,
	  };
	}

	//辞書ベースで、漢字（熟語)と発音のなるべく細かい対応を見つける
	//pronunciationはsurfaceよりも長い必要あり
	function kanjiAllocate (surface, pronunciation, kanji_dict = {}) {
	  let rest_text = pronunciation;
	  //surfaceCursorより前の表層はすべてoutput済み、という単調性を保つ。
	  //未割当文字を別バッファへ退避して後から足すと表層順を逆転できてしまうため、
	  //出力には必ずsurfaceのsliceを左から順番に追加する。
	  let surfaceCursor = 0;
	  let output = [];
	  for(let i=0;i<surface.length;i++){
	    let char = surface[i];
	    if(char in kanji_dict == false){
	      continue;
	    }

	    let yomi_candidates = kanji_dict[char];//長さの降順にソート済みとする
	    const match = findSyllableMatch(rest_text, yomi_candidates);
	    //マッチする読みが見つからなければスキップ
	    if(match == null){
	      continue;
	    }
	    const { start, yomi } = match;
	    const hasPendingSurface = surfaceCursor < i;
	    //読みの手前に割り当てられる部分がない限り、未割当の表層を飛び越えて
	    //後続文字を確定できない。このアンカーは採用せず次を探す。
	    if(start === 0 && hasPendingSurface){
	      continue;
	    }
	    if(start > 0){
	      const prefix = rest_text.slice(0,start);
	      if(hasPendingSurface){
	        //未割当の表層区間を、後続のcharより必ず先に出力する。
	        output.push([surface.slice(surfaceCursor, i), prefix]);
	      }else if(output.length == 0){
	        //先頭文字の辞書読みに接頭音がある場合は同じ文字へ含める。
	        output.push([char, prefix+yomi]);
	        surfaceCursor = i+1;
	        rest_text = rest_text.slice(start+yomi.length);
	        continue;
	      }else{
	        //連続した既知文字間の余剰読みは直前の文字へ含める。
	        output[output.length-1][1] += prefix;
	      }
	    }
	    output.push([char, yomi]);
	    surfaceCursor = i+1;
	    rest_text = rest_text.slice(start+yomi.length);
	  }

	  //ループで処理しきれなかった文字列の処理
	  const remainingSurface = surface.slice(surfaceCursor);
	  if(remainingSurface != ""){
	    if(rest_text != ""){
	      output.push([remainingSurface, rest_text]);
	    }else{
	      if(output.length == 0){
	        //たぶんほとんどないケース
	        output.push([remainingSurface, rest_text]);
	      }else{
	        output[output.length-1][0] += remainingSurface;
	      }
	    }
	  }else{
	    if(rest_text != ""){
	      if(output.length == 0){
	        //この分岐はたぶんない
	      }else{
	        output[output.length-1][1] += rest_text;
	      }
	    }
	  }
	  //output = output.map(function([surface, yomi]){
	  //  return balancedAllocate(surface, yomi);
	  //});
	  //output = output.flat();
	  //アラインメントは表層順を絶対に変えてはならない。細分化に失敗した場合は
	  //安全な全体対応へ戻し、後段の音節分割に任せる。
	  const surfaceInOutput = output.map(([part]) => part).join("");
	  const splitSmallKana = output.slice(1).some(([, yomi]) =>
	    /^[ァィゥェォヮャュョ]/.test(yomi));
	  if(surfaceInOutput !== surface || splitSmallKana){
	    return [[surface, pronunciation]];
	  }
	  return output;
	}
	
	function isFullmatch(text){
		return /^[一-龠]+$/.test(text);
	}
	function toKana(text){
		let kana = "";
		for(let i=0;i<text.length;i++){
			if(text[i] in dictionary == false) continue;
			kana += dictionary[text[i]][0];
		}
		return kana;
	}
	
	return {
		allocate: function(surface, pronunciation){
			return kanjiAllocate(surface, pronunciation, dictionary);
		},
		isFullmatch: isFullmatch,
		toKana: toKana
	}
}

function Character(kanji){
	console.log("kanji in Character",kanji);
	//表層形のかな部分とそれ以外を分割し、タグを付けて返す。
	function kanaTokenize (text) {
	  //例外処理。万が一空文字であれば空のリストを返す
	  if(text == "") return [];

	  //正規表現の宣言
	  let re = /(?<kata>[ァ-ヴー]+)|(?<hira>[ぁ-ゔー]+)|(?<nonkana>[^ぁ-ゔァ-ヴー]+)/g //カタカナ、ひらがな、カナ以外にグループマッチ
	  //マッチする文字列を種類とともに取得
	  let match = text.matchAll(re);
	  match = [...match].map(m=>m.groups);
	  let output = match.map(m=>{
	    let token = {}
	    for(let type in m){
	      if(m[type]){
	        token = {"surface_form":m[type],"type":type}
	        break;
	      }
	    }
	    return token;
	  });
	  
	  return output;
	}

	//ひらがなをカタカナに変換
	function hiraToKata (str) {
	    return str.replace(/[\u3041-\u3096]/g, function(match) {
	        var chr = match.charCodeAt(0) + 0x60;
	        return String.fromCharCode(chr);
	    });
	}

	function kanaAllocate (separated_surface, pronunciation) {
		//console.log(separated_surface, pronunciation);
	  //例外処理。万が一表層形の長さが0のとき、空の配列を返す
	  if(separated_surface.length == 0) return [];
	  //if(pronunciation === ""){
		//  return separated_surface.map(v=>{
		//	 return {"surface_form":v.surface_form, "pronunciation":v.pronunciation, "type":v.type} 
		  //});
	  //}
	  
	  //カナ始まりかどうかを取得
	  let first_kana_index = 1;
	  if(separated_surface[0]["type"] != "nonkana")
	    first_kana_index = 0;
	  let first_nonkana_index = (1-first_kana_index);

	  let output = []
	  let rest_text = pronunciation;
	  
	  for(let i=0;i<separated_surface.length;i++){
	    //surfaceのカナ部分がpronunciationのどこから始まっているかを取得
	    let type = separated_surface[i]["type"]
	    let surface = separated_surface[i]["surface_form"]
	    
	    if(type == "nonkana") continue;

	    let katakana = surface;
	    if(type == "hira") katakana = hiraToKata(surface);
	    
	    let start = rest_text.indexOf(katakana);
	    //カナ部分の始まりが途中からだったら、始めのカナ以外の部分を先に格納する
	    if(start > 0){
	      let nonkana = separated_surface[i-1]
	      //カナが先頭セグメント(i===0)のときは対応する漢字surfaceが無い。読み修正で
	      //カナsurfaceに「そのカナが途中で一致する長い読み」を付けた等で起きる。
	      //従来は separated_surface[-1]=undefined を参照してクラッシュしていたため、
	      //余った先頭の読みはsurfaceを空にして格納する(末尾の余り読み処理と同じ扱い)。
	      output.push({"surface_form":nonkana ? nonkana["surface_form"] : "","pronunciation":rest_text.slice(0,start-rest_text.length), "type":nonkana ? nonkana["type"] : type});
	      rest_text = rest_text.slice(start);
	    }
	    //カナ部分の終わりまでを、格納する
	    output.push({"surface_form":surface,"pronunciation":rest_text.slice(0,katakana.length),"type":type});
	    rest_text = rest_text.slice(katakana.length);
	  }
	  //ループを終えても読みが残っていたら追加する。
	  //本来これは「surfaceがカナ以外(漢字)で終わる」ときのための処理で、余った読みは
	  //その末尾漢字に対応する。しかし末尾がカナのとき(読み修正でカナsurfaceの読みを
	  //長くした等)に全surfaceを重複させてしまうため、その場合はsurfaceを空にする。
	  if(rest_text != ""){
	    let last = separated_surface[separated_surface.length-1];
	    let lastSurface = last["type"] === "nonkana" ? last["surface_form"] : "";
	    output.push({"surface_form":lastSurface, "pronunciation":rest_text,"type":last["type"]});
	  }
	  return output;
	}


	function balancedAllocate (surface, pronunciation) {
		//console.log("balancedAllocate",surface, pronunciation);
	  let id = {surface_form: "surface_form", pronunciation: "pronunciation"}
	  let text = {surface_form: surface, pronunciation: pronunciation}
	  let longer = id.surface_form;
	  let shorter = id.pronunciation;
	  if(surface.length <= pronunciation.length){
	    longer = id.pronunciation;
	    shorter = id.surface_form;
	  }
	  let plusone = text[longer].length % text[shorter].length;
	  let contentlen = Math.floor(text[longer].length/text[shorter].length);

	  let output = [];
	  let longer_pos = 0;
	  for(let i = 0; i<text[shorter].length; i++){

	    let longer_content_len = contentlen;
	    if(i<plusone) longer_content_len += 1;
	    //pronunciationが長いときと短いときで処理を変える
	    if(longer == id.pronunciation){//pronunciationが長いとき、pronunciation1文字ずつに重複する1文字のsurfaceを対応させ、in_order_posで区別する
	      for(let j=0;j<longer_content_len; j++){
	        let info = {}
	        info[longer]=text[longer][longer_pos+j];
	        info[shorter] = text[shorter][i];
	        info["in_surface_pos"] = j;
	        output.push(info);
	      }
	      longer_pos += longer_content_len;
	    }else{//pronunciationが短いとき、pronunciation１文字にsurface複数文字を対応させる
	      let info = {}
	      info[longer] = text[longer].slice(longer_pos, longer_pos + longer_content_len);
	      info[shorter] = text[shorter][i];
	      info["in_surface_pos"] = 0;
	      longer_pos += longer_content_len;
	      //console.log("info",info);
	      output.push(info);
	    }
	  }
	  return output;
	}

	// 手動の表層↔読み割当(manualAlign)が、現在の表層/読みと整合するときだけ採用する。
	// 形は kanjiAllocate と同じ [[surfaceChunk, yomiChunk], ...]。連結して元の
	// surface_form / pronunciation に一致しなければ(読み修正後などで陳腐化していれば)
	// 無効とみなし、通常の自動割当へフォールバックする。
	function validManualAlign(align, surface_form, pronunciation){
		if(!Array.isArray(align) || align.length === 0) return false;
		let s = "", y = "";
		for(const pair of align){
			if(!Array.isArray(pair) || pair.length !== 2) return false;
			if(typeof pair[0] !== "string" || typeof pair[1] !== "string") return false;
			// balancedAllocate が 0 除算しないよう、各チャンクは表層・読みとも非空
			if(pair[0].length === 0 || pair[1].length === 0) return false;
			s += pair[0]; y += pair[1];
		}
		return s === surface_form && y === pronunciation;
	}

	//tokensはkuromojiのtokenizeの結果
	function getCharCorrespondance(tokens, kanji_allocator){
		//console.log("tokens getCharCorrespondance",tokens);

	  //token(単語)のidをふる
		tokens = tokens.map((token,index)=>{
			token.token_index = index;
			return token;
		});
	  //カナ部分とカナ以外部分の対応を見つける
		let kana_correspondance = tokens.map(token=>{
			//console.log("befor",token);

			//if(!token.pronunciation) token.pronunciation = token.surface_form;
			if(!token.pronunciation) token.pronunciation = "";
			let pos = token["pos"]
			//surfaceを解析
			let separated = kanaTokenize(token.surface_form);
			//カナ、カナ以外の対応を見つける
			//console.log(token);
			let correspondance = kanaAllocate(separated, token.pronunciation);
			//記号の場合はtypeに記号を設定する
			// 数字などは解析器によって記号POSになることがある。読み修正やルビで
			// 有効なカナ読みが与えられている場合は、無音の記号として捨てない。
			if(token.pos == "記号" && !/^[ァ-ヴー]+$/.test(token.pronunciation || "")){
				correspondance = correspondance.map(v=>{
					v["type"] = "sign";
					return v;
				});
			}
			//トークンの情報をコピーする
			correspondance = correspondance.map(v=>{
				for(let k in token){
					if(k in v==false){
						v[k] = token[k];
					}
				}
				return v;
			});
			return correspondance;
		});
		kana_correspondance = kana_correspondance.flat(); //1重のリストにする
	  

	  //１文字ずつの対応を見つける
	  let subword_index = -1;
	  //console.log("kana_correspondance",kana_correspondance);
	  let char_correspondance = kana_correspondance.map(token => {
	    let correspondance = null;
	    //console.log("in kana_correspondance",token);
	    if(token.type == "nonkana" && token.surface_form.length > 1 && /^[\w']+$/.test(token.surface_form) == false){
	    	//console.log("in if",token);
		correspondance = validManualAlign(token.manualAlign, token.surface_form, token.pronunciation)
    		? token.manualAlign
    		: kanji_allocator.allocate(token.surface_form, token.pronunciation);
	      correspondance = correspondance.map(function([surface_form,yomi]){
	    	 let c = balancedAllocate(surface_form, yomi);
	    	 //surfaceが１文字のとき何もしない
	    	 if(surface_form.length == 1){
	    		 
	    	 }else{
		    	 //小さい文字から読みが始まるsurfaceがあれば修正する
		    	 for(let i=0;i<c.length;i++){
		    		 let v = c[i];
		    		if(/^[ァィゥェォヮャュョ]/.test(v["pronunciation"]) && v["in_surface_pos"] == 0 && i>0){
		    			//console.log("check smlallvar", v);
		    			
		    			//直前の文字からin_surface_posをふりなおす
		    			for(let j=i-1;j<c.length;j++){
		    				
		    				if(j>=i-1+2 && c[j]["in_surface_pos"] === 0)break;//in_surface_posが0になるまでループする
		    				c[j]["in_surface_pos"] = j-i+1;
		    				c[j]["surface_form"] = v.surface_form;
		    			}
		    		} 
		    	 }	    		 
	    	 }
	    	 //subword_indexを与える(モウラをまたがせない単位)
	    	 subword_index+=1;
	    	 for(let i=0;i<c.length;i++){
	    		 c[i]["subword"]=subword_index;
	    	 }
	    	 
	    	 
	    	 return c;
	      });
	      correspondance = correspondance.flat();
	    }else{
//console.log("in else",token);
	      //かなsurface(または空surface)で読みとモーラ数が食い違う場合、
	      //balancedAllocateは1つのかな文字を複数モーラに複製したり0除算で破綻する。
	      //(編集ツールの読み修正で読みをsurfaceより長くしたとき等。通常の生成では
	      //かなsurfaceは文字数=読み長なので発生しない。単漢字は非カナなので対象外)
	      //食い違い時だけ1モーラ=1エントリで割り当て、surfaceは先頭から1文字ずつ・
	      //余りは空にして複製を防ぐ
	      const surfIsKanaOrEmpty = token.surface_form === "" || /^[ぁ-ゔァ-ヴー]+$/.test(token.surface_form);
	      if(surfIsKanaOrEmpty && token.surface_form.length !== token.pronunciation.length){
	        correspondance = [...token.pronunciation].map((p, i) => ({
	          surface_form: i < token.surface_form.length ? token.surface_form[i] : "",
	          pronunciation: p,
	          in_surface_pos: 0,
	        }));
	      }else{
	        correspondance = balancedAllocate(token.surface_form, token.pronunciation);
	      }
	      //subword_indexを与える(モウラをまたがせない単位)
	      subword_index += 1;
	      for(let i=0;i<correspondance.length;i++){
	    	  correspondance[i]["subword"]=subword_index;
	      }
	    }
	    //tokenのもともとの情報をコピー
	    correspondance = correspondance.map(v => {
	    	for(let k in token){
	    		if(k in v)continue;
	    		v[k] = token[k];
	    	}
	    	return v;
	    });
	    return correspondance;
	  });
	  char_correspondance = char_correspondance.flat();
	  
	  //surfaceのindexを付与
	  let index = -1;
	  char_correspondance = char_correspondance.map(token => {
		 let in_surface_pos = token["in_surface_pos"];
		 //新しい文字の始まりだったらindexを1増やす
		 if(in_surface_pos == 0) index += 1;
		 token["char_index"] = index;
		 return token;
	  });
	  
	  char_correspondance = concatSignToken(char_correspondance);
	  //let k2s = KanaToSyllable();
	  //char_correspondance = setMoraIndex(char_correspondance,k2s.split, k2s.isFullmatch);

	  return char_correspondance;
	}

	//記号のトークンを直前と連結する
	function concatSignToken(tokens){
		let formatted = [];
		let leadingSurface = "";
		for(let token of tokens){
			if(token["type"] === "sign"){
				if(formatted.length > 0){
					formatted[formatted.length-1]["surface_form"] += token["surface_form"];
				}else{
					leadingSurface += token["surface_form"];
				}
				continue;
			}else{
				if(leadingSurface !== ""){
					token["leading_surface"] = leadingSurface;
					leadingSurface = "";
				}
				formatted.push(token);
			}
		}
		return formatted;
	}

	function setMoraIndex(tokens, split, isFullmatch){
		let pronunciation = tokens.map(v=>v["pronunciation"]);
		let mora = split(pronunciation.join(""));
		
		let correspondance = findCorrespondance(pronunciation, mora, function(text){
			if(isFullmatch(text.join(""))){
				//console.log("text",text);
				return split(text.join(""));
			}else{
				return null;
			}
		});
		
		for(let c of correspondance[1]){
			let s1 = c[0];
			let l1 = c[1];
			let s2 = c[2];
			let l2 = c[3];
			for(let i=s1;i<s1+l1;i++){
				tokens[i]["mora_index"] = s2;
			}
		}
		return tokens;
	}

	function getSubwordList(char_tokens){
		let subwords = [];
		let last_index = -1;
		for(let token of char_tokens){
			if(token["subword_index"]!==last_index){
				last_index = token["subword_index"];
				subwords.push([]);
			}
			subwords[subwords.length-1].push(token);
		}
		return subwords;
	}
	return {
		balancedAllocate: balancedAllocate,
		tokenize: function(tokens){
			return getCharCorrespondance(tokens, kanji);
		},
		kanji: kanji
	}
}


export { TokenFormatter, Kanji, Character };
