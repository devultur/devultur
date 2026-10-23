// The guides a package ships: every `docs/guides/*.md` its README links to, copied into the package's own
// `docs/guides/` (shipped through `files`) so an installed version carries the guides that match it. Runs at the end
// of the package's `build`, from the package's directory.
//
// Usage: node ../../scripts/copy-guides.mts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_BLOB = "https://github.com/devultur/devultur/blob/main";
const GUIDE_LINK = /docs\/guides\/([a-z0-9-]+)\.md/g;
// `](target)` of a Markdown link or image, its target relative (not a URL, an anchor or an absolute path).
const RELATIVE_LINK = /\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi;

/** The guides a README links to, by name (`video-player` for `docs/guides/video-player.md`). */
export function linkedGuides(readme: string): string[] {
	return [...new Set([...readme.matchAll(GUIDE_LINK)].map((match) => match[1] as string))].sort();
}

/**
 * A guide as the package ships it: a link to another shipped guide stays relative, and any other relative link (a
 * guide the package doesn't ship, an example, another package) points at the repository instead.
 */
export function shippedGuide(markdown: string, shipped: readonly string[]): string {
	return markdown.replace(RELATIVE_LINK, (link, target: string) => {
		const [path = "", anchor] = target.split("#");
		if (shipped.some((name) => path === `${name}.md`)) return link;
		const repositoryPath = posix.normalize(posix.join("docs/guides", path));
		return `](${REPOSITORY_BLOB}/${repositoryPath}${anchor === undefined ? "" : `#${anchor}`})`;
	});
}

/** Replaces `packageDir/docs` with the guides its README links to. Returns their names. */
export function copyGuides(packageDir: string): string[] {
	const root = join(import.meta.dirname, "..");
	const guides = linkedGuides(readFileSync(join(packageDir, "README.md"), "utf8"));
	const targetDir = join(packageDir, "docs", "guides");
	rmSync(join(packageDir, "docs"), { recursive: true, force: true });
	mkdirSync(targetDir, { recursive: true });
	for (const name of guides) {
		const source = readFileSync(join(root, "docs", "guides", `${name}.md`), "utf8");
		writeFileSync(join(targetDir, `${name}.md`), shippedGuide(source, guides));
	}
	return guides;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const guides = copyGuides(process.cwd());
	console.log(`copy-guides: ${guides.join(", ") || "none"}`);
}
