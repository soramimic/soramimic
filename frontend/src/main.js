import "./style.css";
import { startApp } from "./app.js";

startApp().catch((err) => {
	console.error(err);
	const btn = document.getElementById("btn-convert");
	btn.textContent = "読み込みに失敗しました";
});
