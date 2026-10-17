export async function fetchText(path, options) {
	const res = await fetch(path, options);
	if (!res.ok) throw new Error(`fetch failed: ${res.status} ${path}`);
	return res.text();
}

export async function fetchJson(path) {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`fetch failed: ${res.status} ${path}`);
	return res.json();
}
