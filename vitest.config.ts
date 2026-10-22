// Tests run against the packages' source, so `pnpm test` works in a fresh checkout without building first (each
// package's `exports` point at `dist`, which only `pnpm build` creates).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@devultur\/core$/, replacement: source("core/src/index.ts") },
			{ find: /^@devultur\/server$/, replacement: source("server/src/index.ts") },
			{ find: /^@devultur\/react$/, replacement: source("react/src/index.ts") },
			{ find: /^@devultur\/convex$/, replacement: source("convex/src/index.ts") },
			{ find: /^@devultur\/convex\/react$/, replacement: source("convex/src/react.tsx") },
			{ find: /^@devultur\/convex\/pdfjs$/, replacement: source("convex/src/pdfjs.ts") },
			{ find: /^@devultur\/convex\/convex\.config$/, replacement: source("convex/src/component/convex.config.ts") },
		],
	},
});
