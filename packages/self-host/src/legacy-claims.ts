// TODO(remove after 2026-10-31): tokens signed before the claim rename are still in flight after a deploy (viewer
// tokens default to 2 h, upload tokens live up to 24 h, job tickets 2 days, download links don't carry claims). The
// verifier reads their legacy claim names as the current ones, so they keep working until they expire.

const LEGACY_CLAIM_NAMES: Record<string, string> = {
	pid: "aud",
	ppx: "res",
	pfx: "res",
	vis: "visibility",
	mxb: "max_bytes",
	mxf: "max_files",
	fttl: "file_ttl",
	ctx: "context",
};

const LEGACY_SCOPES_CLAIM = "scopes";

/** The payload with every legacy claim name replaced by the current one (the current one wins). Pure. */
export function withCurrentClaimNames(payload: Record<string, unknown>): Record<string, unknown> {
	const current: Record<string, unknown> = { ...payload };
	for (const [legacy, name] of Object.entries(LEGACY_CLAIM_NAMES)) {
		if (!(legacy in current)) continue;
		if (current[name] === undefined) current[name] = current[legacy];
		delete current[legacy];
	}
	if (LEGACY_SCOPES_CLAIM in current) {
		const scopes = current[LEGACY_SCOPES_CLAIM];
		// A malformed legacy list grants nothing (an empty `scope`), never "no limit".
		const scope = Array.isArray(scopes) ? scopes.filter((entry) => typeof entry === "string").join(" ") : "";
		if (current.scope === undefined) current.scope = scope;
		delete current[LEGACY_SCOPES_CLAIM];
	}
	return current;
}
