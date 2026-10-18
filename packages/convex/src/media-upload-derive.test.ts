import type { DevulturMedia } from "@devultur/core";
import { describe, expect, it, vi } from "vitest";
import { deriveUploadState, type UploadLocalState } from "./media-upload-derive";

const retry = vi.fn();
const IDLE_VIDEO = { phase: "idle" } as const;

const image: DevulturMedia = { id: "img1", kind: "image", visibility: "public", filename: "icon.png" };
const video: DevulturMedia = { id: "vid1", kind: "video", visibility: "private", filename: "clip.mp4" };

const base: UploadLocalState = {
	phase: "idle",
	percent: 0,
	file: null,
	failure: null,
	media: null,
	processRequested: false,
};

describe("deriveUploadState — unified state machine", () => {
	it("idle with nothing", () => {
		expect(deriveUploadState(base, IDLE_VIDEO, retry)).toEqual({ phase: "idle" });
	});

	it("uploading carries percent and file", () => {
		const file = { name: "clip.mp4" } as File;
		const state = deriveUploadState({ ...base, phase: "uploading", percent: 42, file }, IDLE_VIDEO, retry);
		expect(state).toMatchObject({ phase: "uploading", percent: 42, file });
	});

	it("upload-failed → failed stage=upload with retry", () => {
		const failure = { stage: "upload", reason: "network", retriable: true, message: "no network" } as const;
		const state = deriveUploadState({ ...base, phase: "upload-failed", failure }, IDLE_VIDEO, retry);
		expect(state).toMatchObject({ phase: "failed", stage: "upload", reason: "network", retriable: true });
	});

	it("uploaded image → ready directly (no queued/processing or playerProps)", () => {
		const state = deriveUploadState({ ...base, phase: "uploaded", media: image }, IDLE_VIDEO, retry);
		expect(state).toEqual({ phase: "ready", media: image });
	});

	it("video uploaded WITHOUT process (process:false) → ready raw (doesn't enter the reactive tail)", () => {
		const state = deriveUploadState(
			{ ...base, phase: "uploaded", media: video, processRequested: false },
			IDLE_VIDEO,
			retry,
		);
		expect(state).toEqual({ phase: "ready", media: video });
	});

	it("processed video + videoState idle → queued (record propagation window)", () => {
		const state = deriveUploadState(
			{ ...base, phase: "uploaded", media: video, processRequested: true },
			IDLE_VIDEO,
			retry,
		);
		expect(state).toEqual({ phase: "queued", media: video });
	});

	it("processed video + videoState queued → queued", () => {
		const state = deriveUploadState(
			{ ...base, phase: "uploaded", media: video, processRequested: true },
			{ phase: "queued" },
			retry,
		);
		expect(state).toEqual({ phase: "queued", media: video });
	});

	it("processed video + videoState processing → processing with step/percent", () => {
		const state = deriveUploadState(
			{ ...base, phase: "uploaded", media: video, processRequested: true },
			{ phase: "processing", step: "encoding", percent: 60 },
			retry,
		);
		expect(state).toMatchObject({ phase: "processing", media: video, step: "encoding", percent: 60 });
	});

	it("processed video + videoState ready → ready with playerProps", () => {
		const playlist = "https://x/playlist.m3u8";
		const state = deriveUploadState(
			{ ...base, phase: "uploaded", media: video, processRequested: true },
			{
				phase: "ready",
				media: video,
				playlist,
				duration: 120,
				captions: [],
				playerProps: { src: playlist, token: "t", captions: [] },
			},
			retry,
		);
		expect(state).toMatchObject({ phase: "ready", media: video, playlist });
	});

	it("processed video + videoState failed → failed stage=transcode with reason/retriable", () => {
		const state = deriveUploadState(
			{ ...base, phase: "uploaded", media: video, processRequested: true },
			{ phase: "failed", reason: "capacity", message: "didn't start", retriable: true },
			retry,
		);
		expect(state).toMatchObject({ phase: "failed", stage: "transcode", reason: "capacity", retriable: true });
	});
});
