// 読み推定API(soramimic-yomi)クライアント。
// プログレッシブエンハンスメント: 起動時にヘルスチェックし、使えるときだけ
// 歌詞のトークナイズをAPIに任せる。失敗時は呼び出し側がkuromojiへフォールバックする。
// URLは conf/setting.json の yomiApi.url で設定(空/未設定なら無効)。

// 全角英数字・記号を半角に戻す
function toHankaku(s) {
	return s.replace(/[Ａ-Ｚａ-ｚ０-９＇]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0));
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
