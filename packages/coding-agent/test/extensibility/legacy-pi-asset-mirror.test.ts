import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadLegacyPiModule } from "../../src/extensibility/plugins/legacy-pi-compat";

// Regression for issue #1674. Legacy Pi extensions historically read sibling
// asset files via `readFileSync(join(__dirname, "foo.html"))` at module load
// time. `loadLegacyPiModule` mirrors JS/TS modules into a flat temp dir under
// hashed names, so `__dirname` in rewritten code resolves to the mirror root —
// not the extension's source directory. Without explicit asset mirroring the
// `readFileSync` ENOENTs, and consumers like Plannotator silently fall back to
// the "no UI support" path. `mirrorSiblingAssets` now copies `.html`/`.css`
// siblings of every mirrored module into the mirror root.
const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeExtensionDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-legacy-pi-asset-${prefix}-`));
	tempRoots.push(dir);
	return dir;
}

describe("legacy pi compat sibling-asset mirroring (issue #1674)", () => {
	it("copies .html siblings so __dirname-relative readFileSync resolves after mirroring", async () => {
		const dir = await makeExtensionDir("html");
		await fs.writeFile(
			path.join(dir, "index.ts"),
			[
				`import { readFileSync } from "node:fs";`,
				`import { fileURLToPath } from "node:url";`,
				`import * as path from "node:path";`,
				`const here = path.dirname(fileURLToPath(import.meta.url));`,
				`export const content = readFileSync(path.join(here, "ui.html"), "utf8");`,
			].join("\n"),
			"utf8",
		);
		const expected = "<!doctype html><title>plan</title>";
		await fs.writeFile(path.join(dir, "ui.html"), expected, "utf8");

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { content: string };

		expect(mod.content).toBe(expected);
	});

	it("copies .css siblings discovered through transitive relative imports", async () => {
		const dir = await makeExtensionDir("css");
		await fs.mkdir(path.join(dir, "ui"), { recursive: true });
		await fs.writeFile(path.join(dir, "index.ts"), `export { theme } from "./ui/theme";`, "utf8");
		await fs.writeFile(
			path.join(dir, "ui", "theme.ts"),
			[
				`import { readFileSync } from "node:fs";`,
				`import { fileURLToPath } from "node:url";`,
				`import * as path from "node:path";`,
				`const here = path.dirname(fileURLToPath(import.meta.url));`,
				`export const theme = readFileSync(path.join(here, "theme.css"), "utf8");`,
			].join("\n"),
			"utf8",
		);
		const expectedCss = ":root { --bg: #000; }";
		await fs.writeFile(path.join(dir, "ui", "theme.css"), expectedCss, "utf8");

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { theme: string };

		expect(mod.theme).toBe(expectedCss);
	});

	it("does not mirror non-asset siblings such as package.json", async () => {
		const dir = await makeExtensionDir("filter");
		await fs.writeFile(
			path.join(dir, "index.ts"),
			[
				`import { readFileSync, existsSync } from "node:fs";`,
				`import { fileURLToPath } from "node:url";`,
				`import * as path from "node:path";`,
				`const here = path.dirname(fileURLToPath(import.meta.url));`,
				`export const pkgPresent = existsSync(path.join(here, "package.json"));`,
				`export const html = readFileSync(path.join(here, "ui.html"), "utf8");`,
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(dir, "ui.html"), "<p>ok</p>", "utf8");
		await fs.writeFile(path.join(dir, "package.json"), `{ "name": "fixture" }`, "utf8");

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			pkgPresent: boolean;
			html: string;
		};

		expect(mod.html).toBe("<p>ok</p>");
		expect(mod.pkgPresent).toBe(false);
	});
});
