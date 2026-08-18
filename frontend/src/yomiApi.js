// 読み推定API(soramimic-yomi)クライアント。
// プログレッシブエンハンスメント: 起動時にヘルスチェックし、使えるときだけ
// 歌詞のトークナイズをAPIに任せる。失敗時は呼び出し側がkuromojiへフォールバックする。
// URLは conf/setting.json の yomiApi.url で設定(空/未設定なら無効)。

const REQUIRED_CAPABILITIES = ["lossless_surface", "english_reading"];

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
				if (!res.ok) return false;
				const data = await res.json();
				const hasCapability = (name) => Array.isArray(data.capabilities)
					? data.capabilities.includes(name)
					: data.capabilities?.[name] === true;
				return data.token_contract_version >= 2 &&
					REQUIRED_CAPABILITIES.every(hasCapability);
			} catch {
				return false;
			}
		},
		// kuromoji互換トークン列(テキスト配列 → トークン列の配列)。
		// v2契約では表層を一切正規化せず、連結すると入力と完全一致する。
		async tokenize(texts) {
			const data = await post("/tokenize", { text: texts }, timeoutMs);
			if (!Array.isArray(data.tokens) || data.tokens.length !== texts.length) {
				throw new Error("yomi api contract error: invalid token rows");
			}
			for (let i = 0; i < texts.length; i++) {
				const tokens = data.tokens[i];
				if (!Array.isArray(tokens) || tokens.some((t) =>
					!t || typeof t.surface_form !== "string" ||
					typeof t.pronunciation !== "string") ||
					tokens.map((t) => t.surface_form).join("") !== texts[i]) {
					throw new Error(`yomi api contract error: surface mismatch at row ${i}`);
				}
			}
			return data.tokens;
		},
	};
}
