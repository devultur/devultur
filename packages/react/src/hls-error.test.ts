import { describe, expect, it } from "vitest";
import { videoPlayerErrorOf } from "./hls-error";

const encode = (text: string) => new TextEncoder().encode(text).buffer;

describe("videoPlayerErrorOf", () => {
	it("reads the code of a refused playlist from the XHR's text body", () => {
		const error = videoPlayerErrorOf({
			fatal: true,
			details: "manifestLoadError",
			response: { code: 401 },
			networkDetails: { response: '{"code":"session_mismatch","message":"x"}' },
		});
		expect(error).toEqual({ status: 401, code: "session_mismatch", fatal: true, details: "manifestLoadError" });
	});

	it("reports a 401 on a segment even when hls.js would keep going, reading an ArrayBuffer body", () => {
		const error = videoPlayerErrorOf({
			fatal: false,
			details: "fragLoadError",
			response: { code: 401 },
			networkDetails: { response: encode('{"code":"token_rejected"}') },
		});
		expect(error).toMatchObject({ status: 401, code: "token_rejected", fatal: false });
	});

	it("ignores errors hls.js recovers from", () => {
		expect(videoPlayerErrorOf({ fatal: false, details: "fragLoadError", response: { code: 503 } })).toBeNull();
	});

	it("reports fatal errors without a status or a JSON body", () => {
		const error = videoPlayerErrorOf({
			fatal: true,
			details: "bufferStalledError",
			networkDetails: { response: "<html>" },
		});
		expect(error).toEqual({ status: undefined, code: undefined, fatal: true, details: "bufferStalledError" });
	});
});
