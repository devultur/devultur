import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_WORKER_MEGAPIXELS,
	fitsWorkerBudget,
	parseMaxMegapixels,
	planResize,
	resolveOutputFormat,
	resolveRequestedFormat,
	resolveTransformsMode,
	variantStorageKey,
} from "./transform-plan";

const phone = { width: 4032, height: 3024 };

describe("planResize", () => {
	it("scale-down (default) keeps the aspect ratio from a single side", () => {
		expect(planResize(phone, { width: 800 })).toEqual({ width: 800, height: 600 });
	});

	it("scale-down never enlarges", () => {
		expect(planResize({ width: 640, height: 480 }, { width: 1600 })).toEqual({ width: 640, height: 480 });
	});

	it("contain may enlarge", () => {
		expect(planResize({ width: 640, height: 480 }, { width: 1280, fit: "contain" })).toEqual({
			width: 1280,
			height: 960,
		});
	});

	it("cover crops the center to the target aspect", () => {
		expect(planResize(phone, { width: 400, height: 400, fit: "cover" })).toEqual({
			crop: { x: 504, y: 0, width: 3024, height: 3024 },
			width: 400,
			height: 400,
		});
	});

	it("fill stretches to the exact box", () => {
		expect(planResize(phone, { width: 400, height: 400, fit: "fill" })).toEqual({ width: 400, height: 400 });
	});

	it("pad fits inside and keeps the requested canvas", () => {
		expect(planResize(phone, { width: 400, height: 400, fit: "pad" })).toEqual({
			width: 400,
			height: 300,
			canvas: { width: 400, height: 400 },
		});
	});

	it("without dimensions it only re-encodes", () => {
		expect(planResize(phone, { format: "webp" })).toEqual(phone);
	});
});

describe("format resolution", () => {
	const modern = "image/avif,image/webp,*/*";

	it("auto picks AVIF only for outputs up to ~1 MP", () => {
		expect(resolveRequestedFormat({ format: "auto", width: 800 }, modern)).toBe("avif");
		expect(resolveRequestedFormat({ format: "auto", width: 1600, height: 600 }, modern)).toBe("avif");
		expect(resolveRequestedFormat({ format: "auto", width: 1600 }, modern)).toBe("webp");
		expect(resolveRequestedFormat({ format: "auto" }, modern)).toBe("webp");
	});

	it("auto falls back to WebP, then to a baseline every browser decodes", () => {
		expect(resolveRequestedFormat({ format: "auto", width: 400 }, "image/webp,*/*")).toBe("webp");
		expect(resolveRequestedFormat({ format: "auto", width: 400 }, "*/*")).toBe("baseline");
		expect(resolveOutputFormat("baseline", "image/webp")).toBe("jpeg");
		expect(resolveOutputFormat("baseline", "image/png")).toBe("png");
	});

	it("keeps the source format when none is requested", () => {
		expect(resolveOutputFormat(resolveRequestedFormat({ width: 400 }, undefined), "image/png")).toBe("png");
	});
});

describe("variantStorageKey", () => {
	it("lives under the original and is canonical across aliases", () => {
		const key = variantStorageKey("p1/k1/public/image/a.jpg", { width: 400, format: "webp" }, "webp");
		expect(key).toBe("p1/k1/public/image/a.jpg/__variants/w400_h_fit-_q.webp");
	});
});

describe("flags and guard", () => {
	it("defaults to the Worker; cloudflare is only an explicit kill switch", () => {
		expect(resolveTransformsMode(undefined)).toBe("worker");
		expect(resolveTransformsMode("shadow")).toBe("worker");
		expect(resolveTransformsMode("cloudflare")).toBe("cloudflare");
	});

	it("falls back to the default 4 MP budget on garbage", () => {
		expect(DEFAULT_MAX_WORKER_MEGAPIXELS).toBe(4);
		expect(parseMaxMegapixels(undefined)).toBe(4);
		expect(parseMaxMegapixels("nope")).toBe(DEFAULT_MAX_WORKER_MEGAPIXELS);
		expect(parseMaxMegapixels("12")).toBe(12);
	});

	it("rejects sources above the megapixel budget", () => {
		expect(fitsWorkerBudget({ width: 6000, height: 4000 }, 5)).toBe(false);
		expect(fitsWorkerBudget({ width: 2448, height: 1632 }, 5)).toBe(true);
	});

	it("only upscales small outputs in the Worker", () => {
		const small = { width: 640, height: 480 };
		expect(fitsWorkerBudget(small, 5, planResize(small, { width: 1000, fit: "contain" }))).toBe(true);
		expect(fitsWorkerBudget(small, 5, planResize(small, { width: 2000, fit: "contain" }))).toBe(false);
	});

	it("bounds the output too: a huge pad canvas or stretch never reaches the encoder", () => {
		const small = { width: 640, height: 480 };
		expect(fitsWorkerBudget(small, 4, planResize(small, { width: 4096, height: 4096, fit: "pad" }))).toBe(false);
		expect(fitsWorkerBudget(small, 4, planResize(small, { width: 4096, height: 4096, fit: "fill" }))).toBe(false);
	});
});
