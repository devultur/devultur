// jwt-auth: authenticate your backends and users with JWTs from your own identity provider instead of the Worker
// secret. A shared HS256 secret or the provider's JWKS (RS256/ES256) both work. The transcode runner keeps using the
// Worker secret, so jobs outlive any user token.
//
//   createWorker({ plugins: [staticConfig(config), jwtAuth({ jwksUri, issuer, audience }), downloadLinks()] })
import { isOpenRoute, isUploadUrl, updateRequestState, type WorkerPlugin } from "@devultur/self-host";
import { createMiddleware } from "hono/factory";
import { verify, verifyWithJwks } from "hono/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";

export interface JwtAuthOptions {
	/** Your provider's JWKS endpoint. Without it, tokens are HS256 signed with the `JWT_SECRET` secret. */
	jwksUri?: string;
	/** Required `iss`. */
	issuer?: string;
	/** Required `aud`. */
	audience?: string;
	/**
	 * Storage prefix of a verified token, to keep each app (or customer) in its own folder of the bucket. `null` refuses
	 * the token (it names no folder). Default: the bucket root for every token.
	 */
	storagePrefix?: (claims: JWTPayload) => string | null;
}

type JwtAuthEnv = { Bindings: { JWT_SECRET?: string; WORKER_AUTH_SECRET?: string } };

const bearerOf = (header: string | undefined) => header?.match(/^Bearer\s+(\S+)$/i)?.[1];

// Constant-time: the comparison doesn't tell how much of the secret a guess got right.
function isWorkerSecret(token: string, secret: string): boolean {
	if (!secret) return false;
	const encoder = new TextEncoder();
	const [received, expected] = [encoder.encode(token), encoder.encode(secret)];
	let difference = received.byteLength ^ expected.byteLength;
	for (let index = 0; index < expected.byteLength; index++) difference |= (received[index] ?? 0) ^ expected[index];
	return difference === 0;
}

async function verifiedClaims(token: string, secret: string | undefined, options: JwtAuthOptions) {
	const verification = { iss: options.issuer, aud: options.audience };
	try {
		if (options.jwksUri) {
			return await verifyWithJwks(token, {
				jwks_uri: options.jwksUri,
				verification,
				allowedAlgorithms: ["RS256", "ES256"],
			});
		}
		return secret ? await verify(token, secret, { alg: "HS256", ...verification }) : null;
	} catch {
		return null;
	}
}

export function jwtAuth(options: JwtAuthOptions = {}): WorkerPlugin {
	const authenticate = createMiddleware<JwtAuthEnv>(async (context, next) => {
		const { method, path } = context.req;
		const workerSecret = context.env.WORKER_AUTH_SECRET ?? "";
		// The runner uploads the renditions with the Worker secret, and a job's webhook receives it as its bearer.
		updateRequestState(context, { runnerCredential: workerSecret });
		const token = bearerOf(context.req.header("Authorization"));

		if (token && isWorkerSecret(token, workerSecret)) {
			updateRequestState(context, { access: { authenticated: true, trustedRead: true } });
			return next();
		}
		const claims = token ? await verifiedClaims(token, context.env.JWT_SECRET, options) : null;
		const storagePrefix = claims ? (options.storagePrefix ? options.storagePrefix(claims) : "") : null;
		if (storagePrefix !== null) {
			updateRequestState(context, {
				storagePrefix,
				// Your backend reads its private media with its own token: no viewer token needed.
				access: { authenticated: true, trustedRead: path.startsWith("/v1/media/") },
			});
			return next();
		}
		// Public by design, or the upload URL that an authenticated `POST /v1/upload` returned.
		if (isOpenRoute(method, path) || isUploadUrl(path)) return next();
		return context.json({ error: "Unauthorized", code: "unauthorized" }, 401);
	});
	return { name: "jwt-auth", middleware: { auth: [authenticate] } };
}
