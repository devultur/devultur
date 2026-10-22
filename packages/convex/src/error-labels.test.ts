import { DevulturApiError } from "@devultur/core";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { DEVULTUR_ERROR_CODES } from "./error-codes";
import { type DevulturErrorLabels, describeDevulturError, devulturErrorLabels } from "./error-labels";
import { devulturErrorLabels as spanishLabels } from "./locales/es";
import { MediaFetchError } from "./media-fetch";

const LOCALES: Array<[string, DevulturErrorLabels]> = [
	["English", devulturErrorLabels],
	["Spanish", spanishLabels],
];

function refusal(code: string, details?: Record<string, unknown>) {
	return new ConvexError({ code, message: "Worker message", status: 409, ...(details ? { details } : {}) } as never);
}

describe.each(LOCALES)("%s error labels", (_locale, labels) => {
	it("label every code, and only codes", () => {
		expect(Object.keys(labels).sort()).toEqual([...DEVULTUR_ERROR_CODES].sort());
	});

	it.each(DEVULTUR_ERROR_CODES)("label %s with a sentence, with or without details", (code) => {
		for (const details of [{}, { limit: 25_000_000, until: "2030-01-01T00:00:00Z", hold: false }]) {
			const message = describeDevulturError(refusal(code, details), labels);
			expect(message).toMatch(/^\S.*\.$/);
		}
	});
});

describe("describeDevulturError", () => {
	it("describes a component action's refusal, using its details", () => {
		const error = refusal("file_too_large", { limit: 25_000_000 });
		expect(describeDevulturError(error)).toBe("The file exceeds the maximum size (25 MB).");
		expect(describeDevulturError(error, spanishLabels)).toBe("El archivo supera el tamaño máximo (25 MB).");
	});

	it("describes a MediaFetchError and a DevulturApiError", () => {
		expect(describeDevulturError(new MediaFetchError("too_large", "x"), spanishLabels)).toBe(
			"El archivo es demasiado grande para la vista previa.",
		);
		const apiError = new DevulturApiError("x", 413, "file_too_large", 2_000_000, { limit: 2_000_000 });
		expect(describeDevulturError(apiError)).toBe("The file exceeds the maximum size (2 MB).");
	});

	it("overrides some labels and keeps the defaults for the rest", () => {
		const labels = { lock_conflict: "Someone else just changed it." };
		expect(describeDevulturError(refusal("lock_conflict"), labels)).toBe("Someone else just changed it.");
		expect(describeDevulturError(refusal("link_used"), labels)).toBe("This download link was already used.");
	});

	it("tells a hold from a dated retention", () => {
		expect(describeDevulturError(refusal("retention_active", { hold: true }))).toMatch(/on hold/);
		expect(describeDevulturError(refusal("retention_active", { hold: false, until: "2030-06-15T12:00:00Z" }))).toMatch(
			/until Jun 15, 2030/,
		);
	});

	it("gives an unknown code the generic message, and returns null for other errors", () => {
		expect(describeDevulturError(refusal("brand_new_code"))).toBe(devulturErrorLabels.worker_error);
		expect(describeDevulturError(new Error("network"))).toBeNull();
		expect(describeDevulturError("nope")).toBeNull();
	});
});
