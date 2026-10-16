import { makeResultText } from "./convert.js";
import { writeClipboard } from "./clipboard.js";

export function bindResultCopy(button, status, getText, isDisabled = () => false) {
	let copying = false;
	const refresh = () => { button.disabled = copying || isDisabled(); };
	button.addEventListener("click", async () => {
		if (button.disabled) return;
		const text = getText();
		if (!text) return;
		copying = true;
		refresh();
		let state;
		try {
			await writeClipboard(text);
			status.textContent = "コピーしました";
			state = "success";
		} catch (error) {
			console.error(error);
			status.textContent = "コピーに失敗しました";
			state = "error";
		}
		button.classList.add(`copy-${state}`);
		button.title = status.textContent;
		setTimeout(() => {
			copying = false;
			button.classList.remove("copy-success", "copy-error");
			button.title = "出力結果をコピー";
			status.textContent = "";
			refresh();
		}, 1500);
	});
	return refresh;
}

export function createGenerationHistoryView({ container, template, onEdit }) {
	let renderedEntries;
	let busy = false;
	let refreshControls = [];
	return {
		render(entries, disabled) {
			busy = disabled;
			if (renderedEntries !== entries) {
				renderedEntries = entries;
				refreshControls = [];
				container.replaceChildren(...entries.map((entry, index) => {
					const card = template.content.firstElementChild.cloneNode(true);
					card.dataset.historyId = entry.id;
					const heading = card.querySelector("h3");
					heading.id = `history-heading-${index}`;
					heading.textContent = entry.payload.song?.title
						|| entry.payload.phrases?.find(line => line.trim())?.slice(0, 120)
						|| entry.sourceText?.slice(0, 120) || "生成結果";
					card.setAttribute("aria-labelledby", heading.id);
					card.querySelector(".history-wordlist").textContent = entry.payload.wordlist?.text || "単語リスト";
					const date = card.querySelector("time");
					date.dateTime = new Date(entry.createdAt).toISOString();
					date.textContent = new Date(entry.createdAt).toLocaleString("ja-JP", {
						year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
					});
					// Only format a short preview until this result is expanded or copied.
					card.querySelector(".history-preview").textContent = makeResultText(
						(entry.payload.results || []).slice(0, 2), "4").slice(0, 240);
					let fullText;
					const getText = () => fullText ??= makeResultText(entry.payload.results || [], "4");
					const details = card.querySelector("details");
					details.addEventListener("toggle", () => {
						if (details.open) card.querySelector(".output-text").textContent = getText();
					});
					const copy = card.querySelector(".output-copy");
					refreshControls.push(bindResultCopy(copy, card.querySelector("[role=status]"), getText,
						() => busy || !entry.payload.results?.length));
					const edit = card.querySelector(".history-edit");
					edit.addEventListener("click", () => { if (!busy) onEdit(entry); });
					refreshControls.push(() => { edit.disabled = busy; });
					return card;
				}));
			}
			for (const refresh of refreshControls) refresh();
		},
	};
}
