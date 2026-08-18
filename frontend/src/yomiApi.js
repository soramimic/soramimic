// 読み推定API(soramimic-yomi)クライアント。
// プログレッシブエンハンスメント: 起動時にヘルスチェックし、使えるときだけ
// 歌詞のトークナイズをAPIに任せる。失敗時は呼び出し側がkuromojiへフォールバックする。
// URLは conf/setting.json の yomiApi.url で設定(空/未設定なら無効)。

// 全角英数字・記号を半角に戻す
function toHankaku(s) {
	return s.replace(/[Ａ-Ｚａ-ｚ０-９＇]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 読み推定APIは英字を記号品詞へ分割することがあり、空白tokenも返さない。
// 英語辞書による読みと英語行の元表記を保つため、英字を含む行は
// ブラウザ内tokenizerへ任せる（日本語行のAPI読み推定は従来どおり維持する）。
function needsLocalTokenizer(text) {
	return /[A-Za-zＡ-Ｚａ-ｚ]/u.test(text);
}

// API向きの行だけをまとめて問い合わせ、ローカル解析した行と元の順序で結合する。
// 一部の英語行のために、同時入力された日本語行までAPIの読み推定を諦めない。
export async function tokenizePhrasesWithYomiApi(textAnalyzer, yomiApi, phrases) {
	const results = Array(phrases.length);
	const localEntries = [];
	const apiEntries = [];
	phrases.forEach((text, index) => {
		(needsLocalTokenizer(text) ? localEntries : apiEntries).push({ text, index });
	});

	if (localEntries.length > 0) {
		const localTokens = textAnalyzer.tokenizeTogether(localEntries.map((v) => v.text));
		localEntries.forEach((entry, i) => { results[entry.index] = localTokens[i]; });
	}
	if (apiEntries.length > 0) {
		const { chunks, plan } = textAnalyzer.splitByRuby(apiEntries.map((v) => v.text));
		const raw = await yomiApi.tokenize(chunks);
		const apiTokens = textAnalyzer.formatTokensList(
			textAnalyzer.mergeRubyTokens(raw, plan));
		apiEntries.forEach((entry, i) => { results[entry.index] = apiTokens[i]; });
	}
	return results;
}

export function createYomiApi(baseUrl, { timeoutMs = 8000 } = {}) {
	const url = (baseUrl || "").replace(/\/$/, "");

	async function post(path, body, ms) {
		const res = await fetch(url + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(ms),
		});
		if (!res.ok) throw new Error(`yomi api error: ${res.status}`);
		return res.json();
	}

	return {
		enabled: !!url,
		async healthy() {
			if (!url) return false;
			try {
				const res = await fetch(url + "/health", {
					signal: AbortSignal.timeout(3000),
				});
				return res.ok;
			} catch {
				return false;
			}
		},
		// kuromoji互換トークン列(テキスト配列 → トークン列の配列)。
		// pyopenjtalkは英数字の表層を全角化するため半角に戻す
		// (English.jsのBEP辞書処理が表層の半角英字前提のため)
		async tokenize(texts) {
			const data = await post("/tokenize", { text: texts }, timeoutMs);
			return data.tokens.map((tokens) =>
				tokens.map((t) => ({ ...t, surface_form: toHankaku(t.surface_form) })));
		},
	};
}
