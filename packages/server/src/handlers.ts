import { type MediaEvent, MediaEventName, type MediaRouter, type UploadUrlResult } from "@devultur/core";
import type { DevulturRequest, DevulturResponse, HandleUploadOptions, WebhookHandlerConfig } from "./types";

export function createUploadHandler(router: MediaRouter) {
	return async (options: HandleUploadOptions): Promise<UploadUrlResult> => {
		return router.createUploadUrl({
			filename: options.filename,
			contentType: options.contentType,
			metadata: options.metadata,
		});
	};
}

export function createSignedUrlHandler(router: MediaRouter) {
	return async (url: string, expiresIn?: number): Promise<string> => {
		return router.sign(url, { expiresIn });
	};
}

// The media Worker's webhook: `Authorization: Bearer <secret>` and a JSON `MediaEvent` body (see `MediaEventName`).
export function createWebhookHandler(router: MediaRouter, config: WebhookHandlerConfig) {
	return async (request: DevulturRequest): Promise<DevulturResponse> => {
		let event: MediaEvent;
		try {
			event = await router.handleWebhook(request.body, {
				authorization: request.headers.authorization ?? request.headers.Authorization,
				secret: config.secret,
			});
		} catch {
			return { status: 401, headers: { "content-type": "application/json" }, body: { error: "Unauthorized" } };
		}

		await config.onEvent?.(event);
		await dispatchEvent(event, config);
		return { status: 200, headers: { "content-type": "application/json" }, body: { received: true } };
	};
}

async function dispatchEvent(event: MediaEvent, config: WebhookHandlerConfig): Promise<void> {
	switch (event.event) {
		case MediaEventName.TRANSCODE_COMPLETE:
			return config.onTranscodeComplete?.(event);
		case MediaEventName.TRANSCODE_FAILED:
			return config.onTranscodeFailed?.(event);
		case MediaEventName.CAPTIONS_COMPLETE:
			return config.onCaptionsComplete?.(event);
		case MediaEventName.CAPTIONS_FAILED:
			return config.onCaptionsFailed?.(event);
	}
}
