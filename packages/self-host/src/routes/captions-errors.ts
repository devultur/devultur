// Errors from captions providers (Groq, Mistral). Their body can carry the provider's org id,
// quotas and limits: it's logged on the server and the client (response and `captions.failed` webhook) only gets
// a generic message with a stable `code` (HTTP response) or `reason`/`retriable` (webhook: a strict validator
// rejects unknown fields, so the webhook uses the fields the contract already defines).

import type { FailureReason } from "@devultur/core";

export const CaptionsErrorCode = {
	/** The provider responded 429: retriable later. */
	PROVIDER_RATE_LIMITED: "captions_provider_rate_limited",
	/** The provider responded with some other non-2xx. */
	PROVIDER_ERROR: "captions_provider_error",
	/** Something on our end failed (VTT storage, parsing, …). */
	FAILED: "captions_failed",
} as const;

export type CaptionsErrorCode = (typeof CaptionsErrorCode)[keyof typeof CaptionsErrorCode];

/** A provider's non-2xx. `body` is only for logs: it never reaches the client. */
export class CaptionsProviderError extends Error {
	constructor(
		readonly provider: string,
		readonly status: number,
		readonly body: string,
	) {
		super(`${provider} responded ${status}`);
		this.name = "CaptionsProviderError";
	}
}

export interface CaptionsFailure {
	status: 500 | 503;
	code: CaptionsErrorCode;
	error: string;
	reason: FailureReason;
	retriable: boolean;
}

/** Translates a failure into what the client is allowed to see. Includes nothing from the original error. */
export function toCaptionsFailure(error: unknown): CaptionsFailure {
	if (!(error instanceof CaptionsProviderError)) {
		return {
			status: 500,
			code: CaptionsErrorCode.FAILED,
			error: "Captions generation failed",
			reason: "internal",
			retriable: true,
		};
	}
	if (error.status === 429) {
		return {
			status: 503,
			code: CaptionsErrorCode.PROVIDER_RATE_LIMITED,
			error: "Captions provider is rate limited, try again later",
			reason: "capacity",
			retriable: true,
		};
	}
	return {
		status: 500,
		code: CaptionsErrorCode.PROVIDER_ERROR,
		error: "Captions provider failed",
		reason: "internal",
		retriable: error.status >= 500,
	};
}

/** Logs the full failure (including the provider's body) for debugging from the server. */
export function logCaptionsError(context: string, error: unknown): void {
	if (error instanceof CaptionsProviderError) {
		console.error(`[captions] ${context}: ${error.provider} ${error.status}:`, error.body);
		return;
	}
	console.error(`[captions] ${context}:`, error);
}
