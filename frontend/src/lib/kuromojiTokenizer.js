// kuromoji.js のトークナイザを旧MeCabトークナイザと同じインターフェースに適合させる。
// - 未知語で欠落する reading / pronunciation / basic_form は "*" に正規化する
//   (MeCab の出力に合わせる。TextAnalyzer は pronunciation === "*" を未知語判定に使う)
// - tokenize / getYomi とも、配列を渡すと配列で返す(旧MeCabトークナイザと同じ)
export function KuromojiTokenizer(tokenizer) {
	function normalizeToken(token) {
		return {
			surface_form: token.surface_form,
			basic_form: token.basic_form ?? "*",
			reading: token.reading ?? "*",
			pronunciation: token.pronunciation ?? "*",
			pos: token.pos,
			pos_detail_1: token.pos_detail_1,
			pos_detail_2: token.pos_detail_2,
			pos_detail_3: token.pos_detail_3,
			conjugated_form: token.conjugated_form,
			conjugated_type: token.conjugated_type,
			word_position: token.word_position,
		};
	}

	function tokenizeOne(text) {
		return tokenizer.tokenize(text).map(normalizeToken);
	}

	// MeCab -Oyomi 相当: 既知語は読み、未知語は表層をそのまま返す
	function yomiOne(text) {
		return tokenizer
			.tokenize(text)
			.map((t) => (t.reading && t.reading !== "*" ? t.reading : t.surface_form))
			.join("");
	}

	function tokenize(text) {
		return Array.isArray(text) ? text.map(tokenizeOne) : tokenizeOne(text);
	}

	function getYomi(text) {
		return Array.isArray(text) ? text.map(yomiOne) : yomiOne(text);
	}

	return { tokenize, getYomi };
}
