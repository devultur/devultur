import { execFileSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The compiled component as Node's ESM loader sees it once published (run `pnpm build` first). A relative import
// without its extension resolves in Convex's bundler but not in Node, so a test runner loading the component from
// `node_modules` (convex-test under Vitest) needed `server.deps.inline` for it.
const componentDir = fileURLToPath(new URL("../dist/component", import.meta.url));
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']*)["']/g;

let files: string[] = [];

beforeAll(async () => {
	await access(join(componentDir, "convex.config.js")).catch(() => {
		throw new Error("component-imports.test.ts reads the built component: run `pnpm build` first");
	});
	const entries = await readdir(componentDir, { recursive: true });
	files = entries.filter((entry) => /\.(js|d\.ts)$/.test(entry)).map((entry) => join(componentDir, entry));
});

describe("the compiled component's imports", () => {
	it("give every relative import its .js extension", async () => {
		const extensionless: string[] = [];
		for (const file of files) {
			const source = await readFile(file, "utf8");
			for (const [, specifier] of source.matchAll(RELATIVE_SPECIFIER)) {
				if (!specifier?.endsWith(".js")) extensionless.push(`${relative(componentDir, file)}: ${specifier}`);
			}
		}

		expect(files.length).toBeGreaterThan(10);
		expect(extensionless).toEqual([]);
	});

	it("load in Node without a bundler", () => {
		const modules = files
			.filter((file) => file.endsWith(".js"))
			.map((file) => `await import(${JSON.stringify(`file://${file}`)});`);
		const output = execFileSync(
			process.execPath,
			["--input-type=module", "-e", `${modules.join("\n")}\nconsole.log("ok");`],
			{
				cwd: componentDir,
				encoding: "utf8",
			},
		);

		expect(output.trim()).toBe("ok");
	});
});
