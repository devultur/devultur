// API error that preserves the structured fields the worker sends (`{error, code, limit, ...}`)
// so the consumer can programmatically distinguish the reason (e.g. `file_too_large` vs
// `unsupported_media_type`) instead of parsing the human-readable string.
export class DevulturApiError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly limit?: number;
	/**
	 * The response body's fields other than `error` and `code`, e.g. `{ key, mode, until, hold }`
	 * on a `409 retention_active`. `undefined` when the body had none (or wasn't JSON).
	 */
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(message: string, status: number, code?: string, limit?: number, details?: Record<string, unknown>) {
		super(message);
		this.name = "DevulturApiError";
		this.status = status;
		this.code = code;
		this.limit = limit;
		this.details = details;
	}
}

function detailsFrom(body: Record<string, unknown>): Record<string, unknown> | undefined {
	const { error: _error, code: _code, ...rest } = body;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

export async function errorFromResponse(response: Response): Promise<DevulturApiError> {
	let message = `API error: ${response.status}`;
	let code: string | undefined;
	let limit: number | undefined;
	let details: Record<string, unknown> | undefined;
	try {
		const body = await response.json();
		if (typeof body === "object" && body !== null && !Array.isArray(body)) {
			if ("error" in body && typeof body.error === "string") message = body.error;
			if ("code" in body && typeof body.code === "string") code = body.code;
			if ("limit" in body && typeof body.limit === "number") limit = body.limit;
			details = detailsFrom(body);
		}
	} catch {}
	return new DevulturApiError(message, response.status, code, limit, details);
}
