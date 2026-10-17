import "./style.css";
import { setupLegacyLink } from "./legacyTransfer.js";
import { startApp } from "./app.js";

setupLegacyLink(document.getElementById("btn-legacy"), document.getElementById("legacy-status"));

startApp().catch((err) => {
	console.error(err);
	const btn = document.getElementById("btn-convert");
	btn.textContent = "読み込みに失敗しました";
});
