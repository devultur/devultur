// Gives the relative imports of the compiled component (`dist/component`) their `.js` extension.
//
// The source keeps the repo's extensionless imports (bundler resolution), and `tsc` emits them as written. Convex's
// bundler resolves them, but Node's ESM loader doesn't: a test runner that loads the component from `node_modules`
// (convex-test under Vitest) failed on `./_generated/api` unless it inlined the package. Runs after `tsc` in `build`.
//
// Usage: node scripts/add-import-extensions.ts [dir]   (default: dist/component)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const targetDir = resolve(PACKAGE_DIR, process.argv[2] ?? "dist/component");

// `from "./x"`, `import "./x"`, `import("./x")`: the relative specifiers a compiled module or declaration can have.
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']*)\2/g;
const HAS_EXTENSION = /\.(m|c)?js$|\.json$/;

function filesIn(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return filesIn(path);
		return /\.(js|d\.ts)$/.test(name) ? [path] : [];
	});
}

// The specifier with the extension Node resolves it by: `./x.js`, or `./x/index.js` for a directory.
function withExtension(file: string, specifier: string): string {
	if (HAS_EXTENSION.test(specifier)) return specifier;
	const target = resolve(dirname(file), specifier);
	const emitted = (path: string) => existsSync(`${path}.js`) || existsSync(`${path}.d.ts`);
	if (emitted(target)) return `${specifier}.js`;
	if (emitted(join(target, "index"))) return `${specifier}/index.js`;
	throw new Error(`${file}: can't resolve "${specifier}" to an emitted file`);
}

let rewritten = 0;
for (const file of filesIn(targetDir)) {
	const source = readFileSync(file, "utf8");
	const output = source.replace(
		RELATIVE_SPECIFIER,
		(_match, keyword: string, quote: string, specifier: string) =>
			`${keyword}${quote}${withExtension(file, specifier)}${quote}`,
	);
	if (output === source) continue;
	writeFileSync(file, output);
	rewritten += 1;
}
console.log(`add-import-extensions: rewrote ${rewritten} files in ${targetDir}`);
