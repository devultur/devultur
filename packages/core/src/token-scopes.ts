// Scopes of a viewer token (claim `scopes`): what the bearer can do. The worker bakes them in on issuance and
// the delivery gate requires `media:read`. The strings are opaque: whoever issues can use their own.

export const TokenScope = {
	/** Everything the issuing credential can do. */
	ALL: "*",
	/** GET/HEAD of `/v1/media`. */
	MEDIA_READ: "media:read",
} as const;

export type TokenScope = (typeof TokenScope)[keyof typeof TokenScope];

/** Does `granted` cover `required`? */
export type ScopeCoverage = (granted: readonly string[], required: string) => boolean;

/** Default coverage: the exact scope or `*`. */
export function coversScope(granted: readonly string[], required: string): boolean {
	return granted.includes(required) || granted.includes(TokenScope.ALL);
}

/** Scopes from `requested` that `granted` doesn't cover (empty = subset). */
export function missingScopes(
	granted: readonly string[],
	requested: readonly string[],
	covers: ScopeCoverage = coversScope,
): string[] {
	return requested.filter((scope) => !covers(granted, scope));
}
