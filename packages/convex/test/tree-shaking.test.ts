import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What a consumer's bundler keeps from `@devultur/convex/react`. An app importing one component is bundled against the
// packages' real `dist` (run `pnpm build` first), linked into a scratch `node_modules`: tsup splits each package into
// shared chunks, so the `sideEffects` fields decide which chunks and modules come along, as they do once published.
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));
const linkedPackages = ["core", "react", "convex"];

let appDir = "";

beforeAll(async () => {
	await access(join(packagesDir, "convex", "dist", "react", "hooks.js")).catch(() => {
		throw new Error("tree-shaking.test.ts bundles the built packages: run `pnpm build` first");
	});
	appDir = await mkdtemp(join(tmpdir(), "devultur-tree-shaking-"));
	const scopeDir = join(appDir, "node_modules", "@devultur");
	await mkdir(scopeDir, { recursive: true });
	for (const name of linkedPackages) {
		await symlink(join(packagesDir, name), join(scopeDir, name), "dir");
	}
});

afterAll(async () => {
	if (appDir) await rm(appDir, { recursive: true, force: true });
});

// Only React stays external: third-party packages resolve from the linked packages' own `node_modules` and are bundled
// too, so their `sideEffects` fields apply as in an app.
async function bundleApp(contents: string) {
	const result = await build({
		stdin: { contents, resolveDir: appDir, loader: "ts" },
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		external: ["react", "react-dom", "react/*"],
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

describe("tree-shaking @devultur/convex/react/hooks", () => {
	it("keeps an app that only reads the context to the context and its hook", async () => {
		const { code, inputs, gzipBytes } = await bundleApp(
			'import { useDevulturOptional } from "@devultur/convex/react/hooks"; console.log(useDevulturOptional);',
		);

		expect(code).toMatch(/function useDevulturOptional\b/);
		expect(code).not.toMatch(/MediaPicker|MediaLibrary|PdfPreview|VideoPlayer/);
		expect(code).not.toMatch(/function usePaginatedQuery\b/);
		expect(inputs.filter((input) => /hls\.js|pdfjs-dist|@aws-sdk/.test(input))).toEqual([]);
		// Against about 21 kB when the same import came from `@devultur/convex/react`.
		expect(gzipBytes).toBeLessThan(3_000);
	});

	it("leaves the components and Convex's client out of an app that uses every hook", async () => {
		const { code, inputs, gzipBytes } = await bundleApp(
			'import * as hooks from "@devultur/convex/react/hooks"; console.log(hooks);',
		);

		expect(code).toMatch(/function useMediaUrl\b/);
		expect(code).not.toMatch(/function (MediaPicker|MediaLibrary|Preview|PdfPreview|DownloadLink|Image)\b/);
		expect(inputs.filter((input) => /hls\.js|pdfjs-dist|@aws-sdk|node_modules\/convex\//.test(input))).toEqual([]);
		expect(gzipBytes).toBeLessThan(5_000);
	});
});
