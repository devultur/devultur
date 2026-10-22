import type { AttachmentKind } from "./attachment-labels";

// Inline 24×24 stroke icons (no icon dependency); they inherit `currentColor` and are decorative.
const SHEET = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5";

const ICON_PATHS: Record<AttachmentKind, string> = {
	file: SHEET,
	text: `${SHEET} M9 13h6 M9 17h6`,
	pdf: `${SHEET} M8.5 13.5h2a1 1 0 0 1 0 2h-2v-2 M8.5 15.5V17 M13.5 13.5V17h1a1.5 1.5 0 0 0 0-3.5z`,
	image:
		"M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M21 15l-5-5L5 21 M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
	video: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M10 9l5 3-5 3z",
	audio: "M9 18V5l12-2v13 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
};

export function AttachmentIcon({ kind }: { kind: AttachmentKind }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			data-part="icon"
			data-kind={kind}
		>
			<path d={ICON_PATHS[kind]} />
		</svg>
	);
}
