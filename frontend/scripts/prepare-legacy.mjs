import { build } from "vite";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = resolve(process.argv[2] || "");
if (!process.argv[2] || target === root || target === resolve(root, "dist")) {
	throw new Error("Specify the frozen version's built dist directory");
}
const release = JSON.parse(await readFile(new URL("../../conf/legacy-release.json", import.meta.url), "utf8"));
if (!/^[a-f0-9]{40}$/.test(release.commit)) throw new Error("Legacy commit must be pinned");
const temporary = await mkdtemp(join(tmpdir(), "soramimic-legacy-"));
try {
	await build({
		configFile: false, root, publicDir: false,
		build: {
			outDir: temporary, emptyOutDir: true, manifest: true,
			rollupOptions: { input: {
				transfer: resolve(root, "legacy-transfer.html"),
				banner: resolve(root, "src/legacyBanner.js"),
			} },
		},
	});
	const manifest = JSON.parse(await readFile(join(temporary, ".vite/manifest.json"), "utf8"));
	const banner = manifest["src/legacyBanner.js"].file;
	await rm(join(temporary, ".vite"), { recursive: true });
	await cp(temporary, target, { recursive: true });
	for (const file of ["index.html", "editor.html"]) {
		const path = join(target, file);
		const html = await readFile(path, "utf8");
		await writeFile(path, html.replace("</body>", `<script type="module" src="/${banner}"></script></body>`));
	}
	await writeFile(join(target, "legacy-release.json"), JSON.stringify(release) + "\n");
	await writeFile(join(target, "robots.txt"), "User-agent: *\nDisallow: /\n");
	await writeFile(join(target, "_headers"), (await readFile(join(target, "_headers"), "utf8").catch(() => ""))
		+ "\n/*\n  X-Robots-Tag: noindex\n");
} finally {
	await rm(temporary, { recursive: true, force: true });
}
