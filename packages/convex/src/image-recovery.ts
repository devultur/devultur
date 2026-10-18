// Pure client-side delivery error recovery logic (no React) → testable in node.

/** True if a delivery 401 carries `code: "session_mismatch"` (L3 binding): the token is valid but the
 *  fingerprint doesn't match the request (the session secret changed). Reads the body defensively (it may
 *  not be JSON). Used by the fetching paths (video, captions, private `<Image>`) to re-issue and retry. */
export async function isSessionMismatch(response: Response): Promise<boolean> {
	try {
		const data = (await response.clone().json()) as { code?: string };
		return data.code === "session_mismatch";
	} catch {
		return false;
	}
}
