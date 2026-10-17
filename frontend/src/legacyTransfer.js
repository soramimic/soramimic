import { createCustomWordlistRepository, CUSTOM_WORDLISTS_STORAGE_KEY } from "./customWordlists.js";

export const LEGACY_ORIGIN = "https://legacy.soramimic.com";
export const LEGACY_ORIGINS = new Set([LEGACY_ORIGIN, "https://soramimic-legacy.pages.dev"]);
export const TRANSFER_CHANNEL = "soramimic-legacy-wordlists-v1";
export const SOURCE_ORIGINS = new Set([
	"https://soramimic.com", "https://soramimic.pages.dev",
	"https://dev.soramimic.pages.dev", "https://preview.soramimic.pages.dev",
]);
export const TRANSFER_TIMEOUT = 30000;

// Validate through the same repository used by both versions, without touching storage.
export function validateTransferredLists(lists) {
	const raw = JSON.stringify({ version: 1, lists });
	const parsed = createCustomWordlistRepository({ getItem: () => raw }).list();
	return parsed.map(({ id, name, text, createdAt, updatedAt }) => ({ id, name, text, createdAt, updatedAt }));
}

export function importTransferredLists(storage, incoming, makeId = () => crypto.randomUUID()) {
	const lists = validateTransferredLists(incoming);
	// Stage legacy-key migration and merging in memory. A quota or validation failure
	// must leave every existing key intact; commit the full result with one setItem.
	const staged = new Map();
	const repository = createCustomWordlistRepository({
		getItem: key => staged.has(key) ? staged.get(key) : storage.getItem(key),
		setItem: (key, value) => staged.set(key, value),
		removeItem: key => staged.set(key, null),
	});
	const merged = repository.list();
	let added = 0;
	for (const list of lists) {
		if (merged.some(item => item.name === list.name && item.text === list.text)) continue;
		if (merged.some(item => item.id === list.id)) {
			let id;
			do { id = makeId(); } while (merged.some(item => item.id === id));
			merged.push({ ...list, id });
		} else {
			merged.push(list);
		}
		added++;
	}
	storage.setItem(CUSTOM_WORDLISTS_STORAGE_KEY, JSON.stringify({ version: 1, lists: merged }));
	return added;
}

export function setupLegacyLink(button, status) {
	if (!button || !status) return;
	button.addEventListener("click", () => {
		let lists;
		try {
			lists = createCustomWordlistRepository(localStorage).list();
		} catch {
			status.hidden = false;
			status.textContent = "自作リストを読み出せませんでした。保存設定を確認して、もう一度お試しください。";
			return;
		}
		status.hidden = false;
		if (lists.length === 0) {
			window.open(LEGACY_ORIGIN + "/", "_blank", "noopener");
			status.textContent = "旧版を別タブで開きました。";
			return;
		}
		if (!SOURCE_ORIGINS.has(location.origin)) {
			status.textContent = "自作リストの引き継ぎは本番・開発版・プレビューから利用できます。";
			return;
		}
		const nonce = crypto.randomUUID();
		const url = new URL("/legacy-transfer.html", LEGACY_ORIGIN);
		url.hash = new URLSearchParams({ nonce, from: location.origin }).toString();
		let destination;
		let sent = false;
		const finish = message => {
			clearTimeout(timer);
			window.removeEventListener("message", receive);
			button.disabled = false;
			button.removeAttribute("aria-busy");
			status.textContent = message;
		};
		const receive = event => {
			if (event.origin !== LEGACY_ORIGIN || event.source !== destination
				|| event.data?.channel !== TRANSFER_CHANNEL || event.data.nonce !== nonce) return;
			if (event.data.type === "ready" && !sent) {
				sent = true;
				destination.postMessage({ channel: TRANSFER_CHANNEL, nonce, type: "lists", lists }, LEGACY_ORIGIN);
			} else if (event.data.type === "saved") {
				finish("自作リストを旧版にコピーしました。以後の編集はそれぞれに保存されます。");
			} else if (event.data.type === "error") {
				finish("旧版に保存できませんでした。元の自作リストは残っています。別タブの案内をご確認ください。");
			}
		};
		window.addEventListener("message", receive);
		const timer = setTimeout(() => finish("引き継ぎを確認できませんでした。元の自作リストは残っています。もう一度お試しください。"), TRANSFER_TIMEOUT);
		button.disabled = true;
		button.setAttribute("aria-busy", "true");
		status.textContent = "別タブの旧版に自作リストをコピーしています…";
		// Open synchronously in the click handler; the receiving page needs its opener.
		destination = window.open(url.href, "_blank");
		if (!destination) finish("別タブを開けませんでした。ポップアップを許可して、もう一度お試しください。");
	});
}
