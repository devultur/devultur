import type { MediaEvent } from "@devultur/core";

export interface DevulturRequest {
	method: string;
	url: string;
	headers: Record<string, string | undefined>;
	body: unknown;
}

export interface DevulturResponse {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

export interface HandleUploadOptions {
	filename: string;
	contentType: string;
	metadata?: Record<string, string>;
}

/** One event of the media Worker's webhook, narrowed by its `event` name. */
export type MediaEventOf<Name extends MediaEvent["event"]> = Extract<MediaEvent, { event: Name }>;

export interface WebhookHandlerConfig {
	/** The secret the Worker sends as `Authorization: Bearer <secret>`. */
	secret: string;
	/** Every authenticated event, including `transcode.started` and `transcode.progress`. */
	onEvent?: (event: MediaEvent) => Promise<void>;
	onTranscodeComplete?: (event: MediaEventOf<"transcode.complete">) => Promise<void>;
	onTranscodeFailed?: (event: MediaEventOf<"transcode.failed">) => Promise<void>;
	onCaptionsComplete?: (event: MediaEventOf<"captions.complete">) => Promise<void>;
	onCaptionsFailed?: (event: MediaEventOf<"captions.failed">) => Promise<void>;
}
