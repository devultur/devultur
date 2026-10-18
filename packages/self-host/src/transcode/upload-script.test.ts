/// <reference types="node" />
// `upload_asset` with a fake `curl` that logs every call and responds like the worker: single PUT below the
// threshold, multipart (create → exact parts → complete) above it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DERIVED_MULTIPART_THRESHOLD_BYTES, uploadAssetFunction } from "./upload-script";

const FAKE_CURL = [
	"curl() {",
	'  echo "curl $*" >> "$LOG"',
	'  case "$*" in',
	'    *multipart=create*) printf \'{"uploadId":"up+1/x=","partSize":16,"partCount":3}\' ;;',
	// The part returns an etag with escaped quotes (like R2's) and logs the bytes it received.
	'    *partNumber=*) BYTES=$(wc -c | tr -d \' \'); echo "part-bytes $BYTES" >> "$LOG"; printf \'{"partNumber":1,"etag":"\\\\"e%s\\\\""}\' "$BYTES" ;;',
	"    *) cat > /dev/null 2>&1 || true; printf '{}' ;;",
	"  esac",
	"}",
].join("\n");

let workdir = "";

afterEach(() => {
	if (workdir) rmSync(workdir, { recursive: true, force: true });
});

function upload(fileBytes: number, thresholdBytes: number): string[] {
	workdir = mkdtempSync(`${tmpdir()}/upload-asset-`);
	writeFileSync(`${workdir}/out.mp4`, "x".repeat(fileBytes));
	const script = [
		"set -e",
		`LOG=${workdir}/log`,
		"WORKER_URL=https://w UPLOAD_CREDENTIAL=k RESOURCE_SECURITY=",
		FAKE_CURL,
		uploadAssetFunction(thresholdBytes),
		`upload_asset ${workdir}/out.mp4 private/video/v1/mp4/main-1080p.mp4 video/mp4`,
	].join("\n");
	execFileSync("sh", ["-c", script], { encoding: "utf8" });
	return readFileSync(`${workdir}/log`, "utf8").trim().split("\n");
}

describe("upload_asset", () => {
	it("below the threshold: a single PUT with the output's content-type", () => {
		const calls = upload(40, 100);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("-X PUT https://w/v1/upload/private/video/v1/mp4/main-1080p.mp4");
		expect(calls[0]).toContain("Content-Type: video/mp4");
	});

	it("above the threshold: create, exact partSize parts (the last with the remainder) and complete with the etags", () => {
		const calls = upload(40, 10);
		expect(calls[0]).toContain("-X POST https://w/v1/upload/private/video/v1/mp4/main-1080p.mp4?multipart=create");
		expect(calls[0]).toContain('{"size":40,"contentType":"video/mp4"}');
		// uploadId URL-encoded in each part's query.
		expect(calls.filter((call) => call.includes("uploadId=up%2B1%2Fx%3D&partNumber="))).toHaveLength(3);
		expect(calls.filter((call) => call.startsWith("part-bytes"))).toEqual([
			"part-bytes 16",
			"part-bytes 16",
			"part-bytes 8",
		]);
		const complete = calls.at(-1) ?? "";
		expect(complete).toContain("?multipart=complete");
		expect(complete).toContain(
			'{"uploadId":"up+1/x=","parts":[{"partNumber":1,"etag":"\\"e16\\""},{"partNumber":2,"etag":"\\"e16\\""},{"partNumber":3,"etag":"\\"e8\\""}]}',
		);
	});

	it("the default threshold is 50 MB", () => {
		expect(DERIVED_MULTIPART_THRESHOLD_BYTES).toBe(50 * 1024 * 1024);
		expect(uploadAssetFunction()).toContain(`-le ${50 * 1024 * 1024} ]`);
	});
});
