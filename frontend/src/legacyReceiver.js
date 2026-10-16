import { LEGACY_ORIGIN, SOURCE_ORIGINS, TRANSFER_CHANNEL, TRANSFER_TIMEOUT, importTransferredLists } from "./legacyTransfer.js";

const status = document.getElementById("transfer-status");
const parameters = new URLSearchParams(location.hash.slice(1));
const nonce = parameters.get("nonce");
const sourceOrigin = parameters.get("from");
const source = window.opener;
history.replaceState(null, "", location.pathname);

if (location.origin !== LEGACY_ORIGIN || !source || !SOURCE_ORIGINS.has(sourceOrigin)
	|| !/^[a-f0-9-]{36}$/.test(nonce || "")) {
	status.textContent = "自作リストを引き継ぐには、新版の「旧版を使う」ボタンから開いてください。";
} else {
	const finish = () => {
		clearTimeout(timer);
		window.removeEventListener("message", receive);
		window.opener = null;
	};
	const receive = event => {
		if (event.origin !== sourceOrigin || event.source !== source
			|| event.data?.channel !== TRANSFER_CHANNEL || event.data.nonce !== nonce
			|| event.data.type !== "lists") return;
		try {
			importTransferredLists(localStorage, event.data.lists);
		} catch {
			source.postMessage({ channel: TRANSFER_CHANNEL, nonce, type: "error" }, sourceOrigin);
			finish();
			status.textContent = "自作リストを保存できませんでした。ブラウザの保存容量や設定を確認し、新版からもう一度お試しください。既存のリストは上書きしていません。";
			return;
		}
		source.postMessage({ channel: TRANSFER_CHANNEL, nonce, type: "saved" }, sourceOrigin);
		finish();
		location.replace("/");
	};
	window.addEventListener("message", receive);
	const timer = setTimeout(() => {
		finish();
		status.textContent = "引き継ぎを確認できませんでした。新版のタブを開いたまま、もう一度お試しください。";
	}, TRANSFER_TIMEOUT);
	source.postMessage({ channel: TRANSFER_CHANNEL, nonce, type: "ready" }, sourceOrigin);
}
