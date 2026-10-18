// `credentialPolicy()`: the default decision before the Worker issues a credential. Without options it issues what the
// request asks for (the routes already bound every request: upload tokens to 24 h, download links to 7 days).
import type { WorkerPlugin } from "../plugin";
import type { CredentialKind } from "../plugin-hooks";

export interface CredentialPolicyOptions {
	/** Longest lifetime, in seconds, per kind of credential. A longer request is shortened to it, not refused. */
	maxTtlSeconds?: Partial<Record<CredentialKind, number>>;
}

export function credentialPolicy(options: CredentialPolicyOptions = {}): WorkerPlugin {
	return {
		name: "credential-policy",
		issueCredential: (_context, request) => {
			const maxTtlSeconds = options.maxTtlSeconds?.[request.kind];
			if (maxTtlSeconds === undefined) return { allow: true };
			return { allow: true, expiresAt: Date.now() + maxTtlSeconds * 1000 };
		},
	};
}
