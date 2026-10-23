import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What a consumer's bundler keeps from `@devultur/convex/react`. The packages are first built the way tsup builds them
// (one ESM file per entry, dependencies external) into a scratch `node_modules` with their real `package.json`, then an
// app importing one component is bundled against it: the `sideEffects` fields and the statements left at the top of
// each built file decide what comes along, as they do with the published `dist`.
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));
const builtEntries = [
	{ name: "core", entry: "src/index.ts", out: "dist/index.js" },
	{ name: "react", entry: "src/index.ts", out: "dist/index.js" },
	{ name: "convex", entry: "src/react.tsx", out: "dist/react.js" },
];

let appDir = "";

beforeAll(async () => {
	appDir = await mkdtemp(join(tmpdir(), "devultur-tree-shaking-"));
	for (const { name, entry, out } of builtEntries) {
		const packageDir = join(appDir, "node_modules", "@devultur", name);
		await mkdir(packageDir, { recursive: true });
		await copyFile(join(packagesDir, name, "package.json"), join(packageDir, "package.json"));
		await build({
			entryPoints: [join(packagesDir, name, entry)],
			outfile: join(packageDir, out),
			bundle: true,
			format: "esm",
			packages: "external",
			logLevel: "silent",
		});
	}
}, 60_000);

afterAll(async () => {
	if (appDir) await rm(appDir, { recursive: true, force: true });
});

// Third-party packages resolve from the workspace packages' own `node_modules` and are bundled too (only React stays
// external), so their `sideEffects` fields apply as in an app.
const dependencyDirs = builtEntries.map(({ name }) => join(packagesDir, name, "node_modules"));

async function bundleApp(contents: string) {
	const result = await build({
		stdin: { contents, resolveDir: appDir, loader: "ts" },
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		external: ["react", "react-dom", "react/*"],
		nodePaths: dependencyDirs,
		metafile: true,
		logLevel: "silent",
	});
	const code = result.outputFiles[0]?.text ?? "";
	const inputs = Object.entries(Object.values(result.metafile.outputs)[0]?.inputs ?? {})
		.filter(([, input]) => input.bytesInOutput > 0)
		.map(([path]) => path);
	return { code, inputs, gzipBytes: gzipSync(code).length };
}

describe("tree-shaking @devultur/convex/react", () => {
	it("leaves the picker, the library and the paginated query out of an app that only renders <Image>", async () => {
		const { code, inputs, gzipBytes } = await bundleApp(
			'import { Image } from "@devultur/convex/react"; console.log(Image);',
		);

		expect(code).toMatch(/function Image\b/);
		expect(code).not.toMatch(/MediaPicker|MediaLibrary/);
		expect(code).not.toMatch(/function usePaginatedQuery\b/);
		expect(inputs.filter((input) => /hls\.js|@aws-sdk/.test(input))).toEqual([]);
		// Unminified and gzipped: about 9 kB, against over 190 kB minified when the picker and the player came along.
		expect(gzipBytes).toBeLessThan(20_000);
	});

	it.each(["convex", "react"])("@devultur/%s declares itself free of side effects", async (name) => {
		const manifest = JSON.parse(await readFile(join(packagesDir, name, "package.json"), "utf8"));

		expect(manifest.sideEffects).toBe(false);
	});

	it("keeps the picker's parts when the picker is used", async () => {
		const { code } = await bundleApp('import { MediaPicker } from "@devultur/convex/react"; console.log(MediaPicker);');

		expect(code).toContain("function MediaPickerUpload");
		expect(code).toContain("function MediaPickerLibrary");
		expect(code).toMatch(/function usePaginatedQuery\b/);
	});
});
