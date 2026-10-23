// The guides each package's README links to ship with the package (`files` and `copy-guides.mts`), so an installed
// version carries the guides that match it. The shipped copies are checked after `pnpm build`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkedGuides, shippedGuide } from "./copy-guides";

const ROOT = join(import.meta.dirname, "..");
const packages = readdirSync(join(ROOT, "packages")).filter((name) =>
	existsSync(join(ROOT, "packages", name, "README.md")),
);
const guidesOf = (name: string) => linkedGuides(readFileSync(join(ROOT, "packages", name, "README.md"), "utf8"));
const linking = packages.filter((name) => guidesOf(name).length > 0);

describe("the guides a package ships", () => {
	it("cover every package whose README links to a guide", () => {
		expect(linking).toEqual(expect.arrayContaining(["convex", "core", "react", "self-host"]));
		expect(guidesOf("react")).toContain("video-player");
		expect(guidesOf("convex")).toContain("video-player");
	});

	it.each(linking)("are published by %s", (name) => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8"));

		expect(manifest.files).toContain("docs");
		expect(manifest.scripts.build).toContain("copy-guides.mts");
	});

	it.each(linking)("are in %s's build, as copy-guides writes them", (name) => {
		const docsDir = join(ROOT, "packages", name, "docs", "guides");
		if (!existsSync(docsDir))
			throw new Error(`packages/${name}/docs is written by its build: run \`pnpm build\` first`);
		const guides = guidesOf(name);

		expect(readdirSync(docsDir).sort()).toEqual(guides.map((guide) => `${guide}.md`));
		for (const guide of guides) {
			const source = readFileSync(join(ROOT, "docs", "guides", `${guide}.md`), "utf8");
			expect(readFileSync(join(docsDir, `${guide}.md`), "utf8")).toBe(shippedGuide(source, guides));
		}
	});
});

describe("shippedGuide", () => {
	it("keeps links to the guides shipped with it and points the others at the repository", () => {
		const markdown = [
			"[Plugins](plugins.md#hooks)",
			"[Security](security.md)",
			"[Component](../../packages/convex/README.md#object-lock)",
			"[Site](https://example.com/a.md)",
			"[Below](#usage)",
		].join("\n");

		expect(shippedGuide(markdown, ["plugins"]).split("\n")).toEqual([
			"[Plugins](plugins.md#hooks)",
			"[Security](https://github.com/devultur/devultur/blob/main/docs/guides/security.md)",
			"[Component](https://github.com/devultur/devultur/blob/main/packages/convex/README.md#object-lock)",
			"[Site](https://example.com/a.md)",
			"[Below](#usage)",
		]);
	});
});
