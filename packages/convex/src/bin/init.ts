#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONVEX_DIR = findConvexDir();

function findConvexDir(): string {
	const cwd = process.cwd();
	const candidate = join(cwd, "convex");
	if (existsSync(candidate)) return candidate;

	const srcCandidate = join(cwd, "src", "convex");
	if (existsSync(srcCandidate)) return srcCandidate;

	console.error("❌ Could not find convex/ directory. Run this from your project root.");
	process.exit(1);
}

function log(msg: string) {
	console.log(`  ${msg}`);
}

function patchConvexConfig() {
	const configPath = join(CONVEX_DIR, "convex.config.ts");
	const importLine = 'import devultur from "@devultur/convex/convex.config";';
	const useLine =
		'app.use(devultur, { httpPrefix: "/devultur/", env: { DEVULTUR_SECRET: app.env.DEVULTUR_SECRET, DEVULTUR_API_URL: app.env.DEVULTUR_API_URL } });';

	if (!existsSync(configPath)) {
		// The app must declare the env vars it binds: `app.env.<NAME>` throws for an undeclared one.
		const content = `import { defineApp } from "convex/server";
import { v } from "convex/values";
${importLine}

const app = defineApp({ env: { DEVULTUR_SECRET: v.string(), DEVULTUR_API_URL: v.string() } });
${useLine}

export default app;
`;
		writeFileSync(configPath, content);
		log("✅ Created convex/convex.config.ts");
		return;
	}

	let content = readFileSync(configPath, "utf-8");

	if (content.includes("@devultur/convex")) {
		log("⏭️  convex.config.ts already has devultur — skipping");
		if (!content.includes("httpPrefix")) {
			log("⚠️  Mount it with an httpPrefix, or Convex doesn't serve its webhook route and every transcode times out:");
			log('   app.use(devultur, { httpPrefix: "/devultur/", env: { ... } })');
		}
		return;
	}

	if (!content.includes("defineApp")) {
		console.error("❌ convex.config.ts exists but doesn't use defineApp(). Add devultur manually.");
		return;
	}

	const importInsertIndex = content.lastIndexOf("import ");
	const importEndIndex = content.indexOf("\n", importInsertIndex);
	content = `${content.slice(0, importEndIndex + 1)}${importLine}\n${content.slice(importEndIndex + 1)}`;

	const exportIndex = content.indexOf("export default");
	if (exportIndex !== -1) {
		content = `${content.slice(0, exportIndex)}${useLine}\n\n${content.slice(exportIndex)}`;
	}

	writeFileSync(configPath, content);
	log("✅ Patched convex/convex.config.ts with devultur component");
	if (!/DEVULTUR_SECRET:\s*v\./.test(content)) {
		log("⚠️  Declare the env vars it binds in defineApp(), or Convex rejects the config:");
		log("   defineApp({ env: { DEVULTUR_SECRET: v.string(), DEVULTUR_API_URL: v.string() } })");
	}
}

function createDevulturModule() {
	const modulePath = join(CONVEX_DIR, "devultur.ts");

	if (existsSync(modulePath)) {
		log("⏭️  convex/devultur.ts already exists — skipping");
		return;
	}

	const content = `import { CaptionLocale, Devultur, TranscodePreset } from "@devultur/convex";
import { components } from "./_generated/api";

export const {
	issueViewerToken,
	createUploadUrl,
	confirmUpload,
	deleteMedia,
	deleteVideo,
	processVideo,
	getMedia,
	saveProgress,
	loadProgress,
	markComplete,
	resetProgress,
} = Devultur.exposeApi(components.devultur, {
	video: {
		transcodePreset: TranscodePreset.HLS_720P,
		captionLocales: [CaptionLocale.EN],
	},
});
`;
	writeFileSync(modulePath, content);
	log("✅ Created convex/devultur.ts");
}

console.log("\n🔧 @devultur/convex init\n");
console.log(`  Found convex dir: ${CONVEX_DIR}\n`);

patchConvexConfig();
createDevulturModule();

console.log(`
📋 Next steps:
   1. Set your environment variables:
      npx convex env set DEVULTUR_SECRET=<your-worker-credential>
      npx convex env set DEVULTUR_API_URL=https://media.your-domain.com

   2. Run convex dev:
      npx convex dev

   3. Add the provider to your React app:
      import { DevulturProvider } from "@devultur/convex/react";
      import { api } from "../convex/_generated/api";

      <DevulturProvider api={api.devultur}>
        <App />
      </DevulturProvider>

   Transcode webhooks: Convex serves the component's webhook route only because
   convex.config.ts mounts it with httpPrefix "/devultur/". The route is
      POST https://<deployment>.convex.site/devultur/webhook
   and processVideo sends it to the Worker as the callbackUrl (no changes needed in your http.ts).
`);
