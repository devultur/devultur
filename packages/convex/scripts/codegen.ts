// Regenerates `src/component/_generated` from the component's source.
//
// Convex only generates a component's code through an app that mounts it, against a running backend. This script
// builds a throwaway app in a temp directory that mounts a copy of `src/component`, runs `convex codegen` against an
// anonymous local deployment (no account, nothing deployed anywhere), and copies the generated files back.
// Requires `@devultur/core` to be built (`pnpm --filter @devultur/core build`).
//
// Usage: pnpm --filter @devultur/convex codegen
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const COMPONENT_DIR = join(PACKAGE_DIR, "src", "component");
const CORE_DIR = join(PACKAGE_DIR, "..", "core");

const convexDir = dirname(createRequire(join(PACKAGE_DIR, "package.json")).resolve("convex/package.json"));
const appDir = mkdtempSync(join(tmpdir(), "devultur-convex-codegen-"));

const APP_CONFIG = `import { defineApp } from "convex/server";
import { v } from "convex/values";
import devultur from "../devultur/convex.config";

const app = defineApp({ env: { DEVULTUR_SECRET: v.string(), DEVULTUR_API_URL: v.string() } });
app.use(devultur, {
	httpPrefix: "/devultur/",
	env: { DEVULTUR_SECRET: app.env.DEVULTUR_SECRET, DEVULTUR_API_URL: app.env.DEVULTUR_API_URL },
});

export default app;
`;

function createApp() {
	mkdirSync(join(appDir, "convex"));
	mkdirSync(join(appDir, "node_modules", "@devultur"), { recursive: true });
	symlinkSync(convexDir, join(appDir, "node_modules", "convex"));
	symlinkSync(CORE_DIR, join(appDir, "node_modules", "@devultur", "core"));
	writeFileSync(
		join(appDir, "package.json"),
		JSON.stringify({ name: "devultur-codegen", private: true, type: "module", dependencies: { convex: "*" } }),
	);
	writeFileSync(join(appDir, "convex", "convex.config.ts"), APP_CONFIG);
	cpSync(COMPONENT_DIR, join(appDir, "devultur"), {
		recursive: true,
		filter: (source) => !/\.(test|spec)\.ts$/.test(source),
	});
}

// `convex init` writes the anonymous deployment to the app's `.env.local`; an inherited CONVEX_DEPLOYMENT would win.
const { CONVEX_DEPLOYMENT: _inheritedDeployment, ...inheritedEnv } = process.env;

function convex(...args: string[]) {
	execFileSync(process.execPath, [join(convexDir, "bin", "main.js"), ...args], {
		cwd: appDir,
		env: { ...inheritedEnv, CONVEX_AGENT_MODE: "anonymous" },
		stdio: ["ignore", "inherit", "inherit"],
	});
}

try {
	createApp();
	convex("init");
	convex("codegen", "--component-dir", "devultur", "--typecheck", "disable");
	const generatedDir = join(appDir, "devultur", "_generated");
	for (const file of readdirSync(generatedDir)) {
		cpSync(join(generatedDir, file), join(COMPONENT_DIR, "_generated", file));
	}
	console.log("Updated src/component/_generated");
} finally {
	rmSync(appDir, { recursive: true, force: true });
}
