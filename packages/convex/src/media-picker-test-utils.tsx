// Shared by the media picker tests: an XHR the test drives (progress, finish, fail), the actions `useAction` answers
// with, and a picker inside a provider. Not an entry point: never bundled.
import { act, fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import { convexReactMock, LIBRARY_API } from "./media-library-test-utils";

export const actions = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

export function pickerConvexMock() {
	return {
		...convexReactMock(),
		useAction: (reference: string) => (args: Record<string, unknown>) => {
			const action = actions.get(reference);
			if (!action) throw new Error(`No action ${reference}`);
			return action(args);
		},
	};
}

export const PICKER_API = { ...LIBRARY_API, confirmUpload: "confirmUpload" };
export const BASE_URL = "https://media.example";

/** A PUT that stays open until the test reports progress, finishes, or fails it. */
export class DrivenXhr extends EventTarget {
	static sent: DrivenXhr[] = [];
	readonly upload = new EventTarget();
	status = 0;
	responseText = "";
	body: Blob | null = null;
	isAborted = false;

	open() {}
	setRequestHeader() {}

	send(body: Blob) {
		this.body = body;
		DrivenXhr.sent.push(this);
	}

	abort() {
		this.isAborted = true;
		this.dispatchEvent(new Event("abort"));
	}

	progress(fraction: number) {
		const total = this.body?.size ?? 0;
		const event = new ProgressEvent("progress", { lengthComputable: true, loaded: total * fraction, total });
		this.upload.dispatchEvent(event);
	}

	finish(status = 200) {
		this.status = status;
		this.responseText = "{}";
		this.dispatchEvent(new Event("load"));
	}
}

/** Lets pending promises (the upload's awaits) settle. */
export const flush = () => act(async () => {});

/** What `createUploadUrl` returns for `file`: public, its id from its name. */
export function uploadTarget(file: { name: string; type: string }) {
	const id = `id-${file.name}`;
	const kind = file.type.startsWith("image/") ? "image" : "file";
	return {
		url: `https://uploads.example/${id}`,
		key: `public/${kind}/${id}/${file.name}`,
		id,
		kind,
		visibility: "public",
	};
}

export function resetPickerMocks() {
	DrivenXhr.sent = [];
	vi.stubGlobal("XMLHttpRequest", DrivenXhr);
	actions.clear();
	actions.set("issueViewerToken", async () => ({ token: "viewer-token", expiresIn: 3600 }));
	actions.set("createUploadUrl", async (args) =>
		uploadTarget({ name: String(args.filename), type: String(args.contentType) }),
	);
	actions.set("confirmUpload", async () => null);
}

export const pdf = (name = "report.pdf") => new File(["%PDF-1.7 0123456789X"], name, { type: "application/pdf" });

/** Chooses `files` in the picker's file input, as the file dialog would. */
export async function chooseFiles(...files: File[]) {
	const input = document.querySelector<HTMLInputElement>("input[type='file']");
	if (!input) throw new Error("No file input");
	fireEvent.change(input, { target: { files } });
	await flush();
}

export const announced = () =>
	screen.getAllByRole("status").find((node) => node.getAttribute("aria-live"))?.textContent;
