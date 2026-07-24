export async function fetchText(path) {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`fetch failed: ${res.status} ${path}`);
	return res.text();
}

export async function fetchJson(path) {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`fetch failed: ${res.status} ${path}`);
	return res.json();
}
