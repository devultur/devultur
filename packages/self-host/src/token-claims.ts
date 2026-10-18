// Claims of the tokens the Worker signs. Standard names where one exists: `aud` (RFC 7519) is the storage prefix the
// token is valid for, `scope` (RFC 8693 / RFC 9068) is a space-separated list of scopes. `res` is the path prefix
// (resource) its keys must fall under. The Worker sets `aud` itself, so a plugin can never widen it.

/** `aud` claim of a token issued under `storagePrefix` (without its trailing slash). The bucket root adds nothing. */
export function audienceClaim(storagePrefix: string): { aud?: string } {
	const prefix = storagePrefix.replace(/\/$/, "");
	return prefix ? { aud: prefix } : {};
}

/** `scope` claim: the scopes, space-separated. */
export function scopeClaim(scopes: readonly string[]): { scope: string } {
	return { scope: scopes.join(" ") };
}

/** Does any scope contain whitespace (it would read as several scopes in the `scope` claim)? Pure. */
export function hasInvalidScope(scopes: readonly unknown[]): boolean {
	return scopes.some((scope) => typeof scope !== "string" || scope === "" || /\s/.test(scope));
}

/**
 * Scopes of a verified token, from its `scope` claim. `undefined` = the token carries no `scope` (not limited by it);
 * a claim that is not a string carries no scope at all. Pure.
 */
export function readTokenScopes(payload: Record<string, unknown>): string[] | undefined {
	if (payload.scope === undefined) return undefined;
	if (typeof payload.scope !== "string") return [];
	return payload.scope.split(" ").filter(Boolean);
}
