import "./style.css";
import { startApp } from "./app.js";

const INIT_TEXT =
	"変換したい文章をここに入力してください。\n上のボタンでサンプルを試すこともできます";

document.getElementById("input-text").value = INIT_TEXT;

startApp().catch((err) => {
	console.error(err);
	const btn = document.getElementById("btn-convert");
	btn.textContent = "読み込みに失敗しました";
});
