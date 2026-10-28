import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { rolldown } from "rolldown";
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

// The same app code-split around a lazy-loaded route, bundled with Rolldown (Vite's bundler): what loads first is the
// entry and the chunks it imports statically. Rolldown places modules by the exports an entry actually uses, as Rollup
// does; esbuild places whole files by what the entry imports, so its split output can't show this.
async function bundleLazyRouteApp(contents: string) {
	const entryPath = join(appDir, "entry.ts");
	await writeFile(entryPath, contents);
	const bundle = await rolldown({
		input: entryPath,
		platform: "browser",
		external: [/^react($|\/)/, /^react-dom($|\/)/],
		logLevel: "silent",
	});
	const initial = async (minify: boolean) => {
		const { output } = await bundle.generate({ format: "esm", minify });
		const chunks = new Map(output.flatMap((item) => (item.type === "chunk" ? [[item.fileName, item] as const] : [])));
		const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
		if (!entry) throw new Error("rolldown emitted no entry chunk");
		const imported = entry.imports.flatMap((fileName) => chunks.get(fileName) ?? []);
		return { entry, imported };
	};
	const readable = await initial(false);
	const minified = await initial(true);
	await bundle.close();
	return {
		initialCode: [readable.entry, ...readable.imported].map((chunk) => chunk.code).join("\n"),
		initialModules: [readable.entry, ...readable.imported].flatMap((chunk) => Object.keys(chunk.modules)),
		// The entry chunk holds the app's own code; the devultur code it loads first is in the chunks it imports.
		entryDevulturModules: Object.keys(readable.entry.modules).filter((id) => id.includes("/packages/")),
		devulturGzipBytes: minified.imported.reduce((total, chunk) => total + gzipSync(chunk.code).length, 0),
	};
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

	it("keeps the URL hooks and core out of what loads first in an app that lazy-loads the react entry", async () => {
		const { initialCode, initialModules, entryDevulturModules, devulturGzipBytes } = await bundleLazyRouteApp(
			[
				'import { useDevulturOptional } from "@devultur/convex/react/hooks";',
				"console.log(useDevulturOptional);",
				'export const loadMedia = () => import("@devultur/convex/react");',
			].join("\n"),
		);

		expect(initialCode).toMatch(/function useDevulturOptional\b/);
		expect(initialCode).not.toMatch(/function (useMediaUrl|useVideoProps|buildMediaUrl|mediaPath|mediaCaptionPath)\b/);
		expect(initialModules.filter((id) => /packages\/core\//.test(id))).toEqual([]);
		expect(entryDevulturModules).toEqual([]);
		// Minified and gzipped: about 0.15 kB (the contexts and the hooks that only read them), against 0.42 kB in 1.5.2
		// with the throwing hooks' messages and 3.2 kB when one chunk held every hook and core's URL helpers came along.
		expect(devulturGzipBytes).toBeLessThan(200);
	});

	// What loaded first in 1.5.2, minified and gzipped, for either hook: the contexts' chunk also held the throwing
	// hooks, their messages and `DevulturCapabilityError`.
	const initialGzipBytesIn152 = 421;

	it.each([
		"useCanDeliver",
		"useDevulturOptional",
	])("keeps the throwing hooks' messages out of what loads first in a lazy-route app that uses %s", async (hook) => {
		const { initialCode, devulturGzipBytes } = await bundleLazyRouteApp(
			[
				`import { ${hook} } from "@devultur/convex/react/hooks";`,
				`console.log(${hook});`,
				'export const loadMedia = () => import("@devultur/convex/react");',
			].join("\n"),
		);

		expect(initialCode).toMatch(new RegExp(`function ${hook}\\b`));
		expect(initialCode).not.toMatch(/DevulturCapabilityError|isn't available under/);
		expect(initialCode).not.toMatch(/must be used within|requires progress API/);
		expect(initialCode).not.toMatch(/function (useDevultur|useDevulturApi|useDevulturProgress)\b/);
		expect(devulturGzipBytes).toBeLessThan(initialGzipBytesIn152);
	});

	it("keeps the URL hooks out of what loads first in a lazy-route app that uses useDevultur", async () => {
		const { initialCode } = await bundleLazyRouteApp(
			[
				'import { useDevultur } from "@devultur/convex/react/hooks";',
				"console.log(useDevultur);",
				'export const loadMedia = () => import("@devultur/convex/react");',
			].join("\n"),
		);

		expect(initialCode).toMatch(/function useDevultur\b/);
		expect(initialCode).not.toMatch(/function (useMediaUrl|useVideoProps|buildMediaUrl)\b/);
	});
});
