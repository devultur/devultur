import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { DEVULTUR_ERROR_CODES } from "../error-codes";
import { MediaFetchError } from "../media-fetch";
import * as es from "./es";
import * as esFormal from "./es-formal";

// The shape of a module's exports: nested keys, with each leaf's type ("string", "function", ...).
function shapeOf(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return typeof value;
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	return Object.fromEntries(entries.map(([key, entry]) => [key, shapeOf(entry)]));
}

const refusal = (code: string, details: Record<string, unknown> = {}) =>
	new ConvexError({ code, message: "Worker message", status: 409, details } as never);

// Arguments every label function is called with: label details, flags, names, page counts, kinds, codes and errors.
const SAMPLE_ARGUMENTS: unknown[][] = [
	[{}],
	[{ field: "title" }],
	[{ field: "alt" }],
	[{ field: "tags" }],
	[{ hold: true }],
	[{ until: "2030-01-01T00:00:00Z", limit: 25_000_000, shown: 3, total: 10 }],
	[true],
	[false],
	["informe.pdf"],
	["informe.pdf", 3],
	[1, 3],
	[1_234_567],
	[42],
	...["image", "video", "pdf", "audio", "text", "file"].map((kind) => [kind]),
	...DEVULTUR_ERROR_CODES.map((code) => [code]),
	...DEVULTUR_ERROR_CODES.map((code) => [refusal(code)]),
	[new MediaFetchError("http_error", "x", 503)],
	[new Error("network")],
];

function callSafely(label: (...args: unknown[]) => unknown, args: unknown[]): unknown {
	try {
		return label(...args);
	} catch {
		return undefined;
	}
}

// Every string a module can produce: its strings, and what its functions return for the sample arguments.
function stringsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (typeof value === "function") {
		const label = value as (...args: unknown[]) => unknown;
		return SAMPLE_ARGUMENTS.map((args) => callSafely(label, args)).filter((text) => typeof text === "string");
	}
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(stringsOf);
}

// Common «tú» forms (verbs, imperatives, pronouns), as whole words.
const INFORMAL_FORMS = [
	"tienes",
	"puedes",
	"quieres",
	"debes",
	"alcanzaste",
	"vuelve",
	"intenta",
	"inténtalo",
	"revisa",
	"sube",
	"súbelo",
	"elige",
	"suelta",
	"busca",
	"usa",
	"tu",
	"tus",
	"ti",
];
const INFORMAL = new RegExp(`(?<!\\p{L})(${INFORMAL_FORMS.join("|")})(?!\\p{L})`, "iu");

const informalStringsOf = (module: unknown) => [...new Set(stringsOf(module))].filter((text) => INFORMAL.test(text));

describe("locales/es-formal", () => {
	it("exports exactly what locales/es exports, key by key", () => {
		expect(shapeOf(esFormal)).toEqual(shapeOf(es));
	});

	it("has no informal «tú» forms", () => {
		expect(informalStringsOf(esFormal)).toEqual([]);
	});

	it("is checked by a heuristic that catches locales/es's «tú»", () => {
		expect(informalStringsOf(es)).toContain("Tu sesión cambió. Vuelve a cargar la página.");
	});

	it("describes errors in the library and the picker with the formal labels", () => {
		const error = refusal("unauthorized");
		expect(esFormal.mediaLibraryLabels.error(error)).toBe("No tiene autorización para hacer esto.");
		expect(esFormal.mediaPickerLabels.uploadError(error)).toBe("No tiene autorización para hacer esto.");
		expect(esFormal.previewLabels.error("session_mismatch")).toBe("Su sesión cambió. Vuelva a cargar la página.");
	});

	it("keeps the strings that don't address the reader", () => {
		expect(esFormal.devulturErrorLabels.link_used).toBe(es.devulturErrorLabels.link_used);
		expect(esFormal.attachmentLabels).toBe(es.attachmentLabels);
		expect(esFormal.previewLabels.page(2, 5)).toBe("Página 2 de 5");
	});
});
