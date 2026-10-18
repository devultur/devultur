// Path prefix of a credential: restricts it to the media keys under that prefix, RELATIVE to the storage prefix and without
// the visibility segment (`image/`, `video/<id>/`). Stored normalized: no leading `/` and a trailing `/`, so the
// comparison is by segments (`video/ab/` doesn't cover `video/abc/`). This file must not import anything, so it can be
// consumed by relative path without dragging in dependencies.

const VISIBILITY_SEGMENTS = new Set(["public", "private"]);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_PATH_PREFIX_LENGTH = 256;

function isSafeSegment(segment: string): boolean {
	return SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

/** Normalizes a requested `pathPrefix`. `null` = invalid (empty, `..`, encoded, or starts with a visibility segment). */
export function normalizePathPrefix(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > MAX_PATH_PREFIX_LENGTH) return null;
	const segments = raw
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.split("/");
	if (segments.length === 0 || segments[0] === "") return null;
	if (VISIBILITY_SEGMENTS.has(segments[0])) return null;
	if (!segments.every(isSafeSegment)) return null;
	return `${segments.join("/")}/`;
}

/**
 * Virtual key (`{visibility}/{kind}/{id}/…`) → relative path without the visibility. `null` if it doesn't start
 * with a visibility segment or carries empty/`.`/`..`/unsafe segments (can't be checked against a prefix).
 */
export function relativeMediaPath(virtualKey: string): string | null {
	const segments = virtualKey.split("/");
	if (!VISIBILITY_SEGMENTS.has(segments[0] ?? "")) return null;
	const rest = segments.slice(1);
	const isTrailingSlash = rest.at(-1) === "";
	const named = isTrailingSlash ? rest.slice(0, -1) : rest;
	if (named.length === 0 || !named.every(isSafeSegment)) return null;
	return `${named.join("/")}${isTrailingSlash ? "/" : ""}`;
}

/** Does the relative path fall under the prefix? No prefix = no restriction. */
export function isWithinPathPrefix(relativePath: string, pathPrefix: string | undefined): boolean {
	if (!pathPrefix) return true;
	return relativePath.startsWith(pathPrefix);
}

/** Is the `child` prefix within `parent`? A child with no prefix under a parent with one would widen it. */
export function isPrefixWithin(child: string | undefined, parent: string | undefined): boolean {
	if (!parent) return true;
	if (!child) return false;
	return child.startsWith(parent);
}
