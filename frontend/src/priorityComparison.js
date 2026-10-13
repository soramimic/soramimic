import { priorityMetrics, matchesPriority } from "./lib/priorityPlacement.js";

const title = { score: "音の近さで優先（従来）", placement: "先に配置して生成" };

export function generatePriorityVariant(app, prepared, param, signal, onProgress) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new DOMException("中止しました", "AbortError")); return; }
		let handle;
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const abort = () => { handle?.cancel(); cleanup(); reject(new DOMException("中止しました", "AbortError")); };
		try {
			handle = app.soramimiMaker.generateFromTokens(prepared.tokensList, prepared.db, param,
				(_, line) => onProgress?.(line), (results, diagnostics) => { cleanup(); resolve({ results, diagnostics }); });
			handle.finished?.catch(error => { cleanup(); reject(error); });
			signal?.addEventListener("abort", abort, { once: true });
		} catch (error) { cleanup(); reject(error); }
	});
}

export function createPriorityComparison({ prepare, onChoose }) {
	const dialog = document.createElement("dialog");
	dialog.className = "priority-comparison";
	dialog.id = "priority-comparison";
	dialog.setAttribute("aria-labelledby", "priority-comparison-title");
	const header = document.createElement("div");
	header.className = "priority-comparison-header";
	const heading = document.createElement("h2");
	heading.id = "priority-comparison-title";
	heading.textContent = "優先単語の使い方を比較";
	const close = document.createElement("button");
	close.type = "button"; close.className = "btn"; close.textContent = "閉じる";
	close.addEventListener("click", () => dialog.close());
	header.append(heading, close);
	const status = document.createElement("p");
	status.setAttribute("role", "status");
	const note = document.createElement("p");
	note.className = "field-note";
	note.textContent = "同じ入力で比較します。「先に配置」は音が離れていても指定語の採用を最優先します。青い語が優先指定です。音の距離は低いほど近く、未変換箇所は距離に含めず別に表示します。";
	const columns = document.createElement("div");
	columns.className = "priority-comparison-columns";
	dialog.append(header, status, note, columns);
	document.body.append(dialog);
	let controller;
	dialog.addEventListener("close", () => controller?.abort());

	return {
		async start() {
			controller?.abort();
			const request = new AbortController(); controller = request;
			columns.replaceChildren(); status.textContent = "比較の準備中…";
			dialog.showModal();
			try {
				const prepared = await prepare();
				if (request.signal.aborted) return;
				for (const strategy of ["score", "placement"]) {
					status.textContent = `${title[strategy]}で生成中…`;
					const param = { ...prepared.param, PRIORITY_STRATEGY: strategy };
					const { results } = await generatePriorityVariant(prepared.app, prepared, param, request.signal,
						line => { status.textContent = `${title[strategy]}：${line + 1}/${prepared.phrases.length}行`; });
					if (request.signal.aborted) return;
					const metrics = priorityMetrics(results, param.PRIORITY_WORDS);
					const panel = document.createElement("section"); panel.className = "priority-comparison-column";
					panel.dataset.strategy = strategy;
					const name = document.createElement("h3"); name.textContent = title[strategy];
					const stats = document.createElement("p"); stats.className = "priority-comparison-stat";
					stats.textContent = `優先語 ${metrics.included.length}/${metrics.requested}語 · 音の距離 ${metrics.distance.toFixed(1)} · 未変換 ${metrics.fillerUnits}音節`;
					const missing = document.createElement("p"); missing.className = "field-note";
					missing.textContent = metrics.missing.length ? "使われなかった語：" + metrics.missing.map(word => word.scope === "word" ? word.original : word.surface).join("、") : "指定した語がすべて使われています。";
					const choose = document.createElement("button"); choose.type = "button"; choose.className = "btn btn-primary";
					choose.textContent = "この結果を編集する";
					choose.addEventListener("click", () => {
						if (controller !== request) return;
						dialog.close();
						onChoose({ prepared, results, param }).catch(error => { status.textContent = error.message; if (!dialog.open) dialog.showModal(); });
					});
					panel.append(name, stats, missing, choose);
					results.forEach((words, line) => {
						const row = document.createElement("div"); row.className = "priority-comparison-line";
						const original = document.createElement("small"); original.textContent = prepared.phrases[line]; row.append(original);
						for (const word of words) {
							const span = document.createElement("span"); span.className = "priority-comparison-word";
							span.classList.toggle("preferred", param.PRIORITY_WORDS.some(preferred => matchesPriority(word, preferred)));
							span.classList.toggle("filler", !!word.filler); span.textContent = word.surface;
							span.title = word.kana || ""; row.append(span);
						}
						panel.append(row);
					});
					columns.append(panel);
				}
				status.textContent = "両方式の生成が完了しました。";
			} catch (error) {
				if (!request.signal.aborted) status.textContent = "比較できませんでした：" + error.message;
			}
		},
	};
}
