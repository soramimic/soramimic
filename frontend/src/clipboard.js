// Clipboard APIはHTTPS(または localhost)でしか使えないため、
// LAN実機確認のようなhttp環境では一時テキストエリアで代替する。
export async function writeClipboard(text) {
	if (navigator.clipboard && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.focus();
	ta.select();
	const ok = document.execCommand("copy");
	ta.remove();
	if (!ok) throw new Error("クリップボードに書き込めませんでした");
}
