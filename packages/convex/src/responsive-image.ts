// `srcset` and width picking for `<Image widths>`. Pure apart from reading the viewport in `renderedWidthFromSizes`.

/** The widths, positive whole numbers, deduplicated and ascending. */
export function normalizeWidths(widths: readonly number[]): number[] {
	const validWidths = widths.filter((width) => Number.isInteger(width) && width > 0);
	return [...new Set(validWidths)].sort((a, b) => a - b);
}

/** `url(640) 640w, url(1280) 1280w`, one candidate per width. */
export function buildSrcSet(widths: readonly number[], urlForWidth: (width: number) => string): string {
	return widths.map((width) => `${urlForWidth(width)} ${width}w`).join(", ");
}

/** A transform height that keeps the `width`×`height` ratio at `targetWidth`; `undefined` without both. */
export function scaledHeight(targetWidth: number, width?: number, height?: number): number | undefined {
	if (!width || !height) return undefined;
	return Math.round((targetWidth * height) / width);
}

/**
 * The one width a private image is fetched at (a `blob:` URL can't be a `srcset` candidate): the largest width up to
 * twice the rendered width, else the smallest. Without a rendered width, the largest.
 */
export function pickWidth(widths: readonly number[], renderedWidth: number | null): number | undefined {
	const ascending = normalizeWidths(widths);
	if (renderedWidth === null) return ascending.at(-1);
	const fitting = ascending.filter((width) => width <= renderedWidth * 2);
	return fitting.at(-1) ?? ascending[0];
}

const LENGTH = /^(\d+(?:\.\d+)?)(px|vw)$/;

function lengthInPixels(length: string, viewportWidth: number): number | null {
	const match = LENGTH.exec(length.trim());
	if (!match) return null;
	const amount = Number(match[1]);
	return match[2] === "vw" ? (amount * viewportWidth) / 100 : amount;
}

function matchesMedia(condition: string): boolean {
	if (typeof window.matchMedia !== "function") return false;
	return window.matchMedia(condition).matches;
}

/**
 * The CSS width `sizes` gives the image in this viewport, as the browser would pick it: the first entry whose media
 * condition matches, else the last one. Only `px` and `vw` lengths are read (`calc()` and others → `null`), and
 * `null` outside the browser.
 */
export function renderedWidthFromSizes(sizes: string | undefined): number | null {
	if (!sizes || typeof window === "undefined") return null;
	const entries = sizes.split(",").map((entry) => entry.trim());
	for (const entry of entries) {
		const lengthStart = entry.lastIndexOf(" ") + 1;
		const condition = entry.slice(0, lengthStart).trim();
		if (condition && !matchesMedia(condition)) continue;
		return lengthInPixels(entry.slice(lengthStart), window.innerWidth);
	}
	return null;
}
