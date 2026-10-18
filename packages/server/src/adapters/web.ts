import type { DevulturRequest, DevulturResponse } from "../types";

export async function fromWebRequest(request: Request): Promise<DevulturRequest> {
	const headers: Record<string, string | undefined> = {};
	request.headers.forEach((value, key) => {
		headers[key] = value;
	});

	let body: unknown = null;
	if (request.method !== "GET" && request.method !== "HEAD") {
		const contentType = request.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			body = await request.json();
		} else {
			body = await request.text();
		}
	}

	return {
		method: request.method,
		url: request.url,
		headers,
		body,
	};
}

export function toWebResponse(response: DevulturResponse): Response {
	const body = typeof response.body === "string" ? response.body : JSON.stringify(response.body);

	return new Response(body, {
		status: response.status,
		headers: response.headers,
	});
}
