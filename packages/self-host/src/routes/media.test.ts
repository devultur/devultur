import { describe, expect, it } from "vitest";
import { downloadDisposition } from "./media";

describe("downloadDisposition (?download)", () => {
	it("reuses the stored original name, swapping inline → attachment", () => {
		const stored = `inline; filename="Cafe Nandu.jpg"; filename*=UTF-8''Caf%C3%A9%20%C3%91and%C3%BA.jpg`;
		expect(downloadDisposition(stored, "image/abc/x.jpg", "")).toBe(
			`attachment; filename="Cafe Nandu.jpg"; filename*=UTF-8''Caf%C3%A9%20%C3%91and%C3%BA.jpg`,
		);
	});

	it("prefers an explicit filename over the stored one", () => {
		const stored = `inline; filename="original.jpg"`;
		expect(downloadDisposition(stored, "image/abc/original.jpg", "renamed.jpg")).toBe(
			`attachment; filename="renamed.jpg"; filename*=UTF-8''renamed.jpg`,
		);
	});

	it("falls back to the key basename when nothing is stored", () => {
		expect(downloadDisposition(undefined, "file/abc/report.pdf", "")).toBe(
			`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		);
	});

	it("encodes non-ASCII names (RFC 5987)", () => {
		expect(downloadDisposition(undefined, "image/abc/x", "Café Ñandú.jpg")).toBe(
			`attachment; filename="Caf_ _and_.jpg"; filename*=UTF-8''Caf%C3%A9%20%C3%91and%C3%BA.jpg`,
		);
	});
});
