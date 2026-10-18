// API error that preserves the structured fields the worker sends (`{error, code, limit}`)
// so the consumer can programmatically distinguish the reason (e.g. `file_too_large` vs
// `unsupported_media_type`) instead of parsing the human-readable string.
export class DevulturApiError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly limit?: number;

	constructor(message: string, status: number, code?: string, limit?: number) {
		super(message);
		this.name = "DevulturApiError";
		this.status = status;
		this.code = code;
		this.limit = limit;
	}
}

export async function errorFromResponse(response: Response): Promise<DevulturApiError> {
	let message = `API error: ${response.status}`;
	let code: string | undefined;
	let limit: number | undefined;
	try {
		const body = await response.json();
		if (typeof body === "object" && body !== null) {
			if ("error" in body && typeof body.error === "string") message = body.error;
			if ("code" in body && typeof body.code === "string") code = body.code;
			if ("limit" in body && typeof body.limit === "number") limit = body.limit;
		}
	} catch {}
	return new DevulturApiError(message, response.status, code, limit);
}
