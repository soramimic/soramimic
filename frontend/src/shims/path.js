// kuromoji の DictionaryLoader がブラウザでも `path.join` を呼ぶための最小シム。
// URLパスの結合にしか使われない。
export function join(...parts) {
	return parts.join("/").replace(/\/{2,}/g, "/");
}
export default { join };
