// `workerSecretAuth()`: the default authentication. Control routes (create uploads, delete, list, transcode, captions,
// issue tokens) require `Authorization: Bearer <WORKER_AUTH_SECRET>`, the credential of the backend that owns the
// Worker. Routes that are public by design, or that verify their own credential, stay open. See `isOpenRoute`.
import type { Context, MiddlewareHandler } from "hono";
import { isBearerAuthorized } from "../bearer";
import { verifyViewerToken } from "../helpers";
import type { WorkerPlugin } from "../plugin";
import { updateRequestState } from "../request-state";
import { uploadGrantFromClaims } from "../routes/token-upload";
import type { UploadGrant, WorkerApp } from "../types";

export const WorkerAuthErrorCode = {
	SECRET_MISSING: "worker_auth_secret_missing",
	UNAUTHORIZED: "unauthorized",
} as const;

const MEDIA_PREFIX = "/v1/media/";
const DOWNLOAD_PREFIX = "/v1/download/";
const WEBHOOKS_PREFIX = "/v1/webhooks/";
const UPLOAD_CREATE_PATH = "/v1/upload";
const UPLOAD_URL_PREFIX = "/v1/upload/";

const isReadMethod = (method: string) => method === "GET" || method === "HEAD";

/**
 * Routes that never need a credential. Pure.
 * - `/health` and the playback metrics endpoint: public by design.
 * - Media delivery: public media is tokenless; the route itself requires a viewer token for private media.
 * - Download links: the opaque link id is the credential.
 * - Webhooks: they check their own shared secret.
 */
export function isOpenRoute(method: string, path: string): boolean {
	if (method === "OPTIONS") return true;
	if (path === "/health") return isReadMethod(method);
	if (path === "/v1/metrics/playback") return method === "POST";
	if (path.startsWith(MEDIA_PREFIX) || path.startsWith(DOWNLOAD_PREFIX)) return isReadMethod(method);
	return path.startsWith(WEBHOOKS_PREFIX) && method === "POST";
}

/**
 * An upload URL (`/v1/upload/<key>`): the URL that `POST /v1/upload` returned is the credential. Without an
 * authenticated request it only acts on that upload (see `RequestAccess.authenticated`). Pure.
 */
export function isUploadUrl(path: string): boolean {
	return path.startsWith(UPLOAD_URL_PREFIX);
}

/** Grant of a valid upload token (`POST /v1/token/upload`) in the bearer, or null. */
async function uploadGrantFromBearer(context: Context<WorkerApp>, authHeader: string | undefined) {
	const token = authHeader?.match(/^Bearer\s+(\S+)$/i)?.[1];
	const signSecret = context.env.DELIVERY_SIGN_SECRET;
	if (!token || !signSecret) return null;
	try {
		const payload = await verifyViewerToken(token, signSecret);
		return payload ? uploadGrantFromClaims(payload) : null;
	} catch {
		return null;
	}
}

function rejectUnauthenticated(context: Context<WorkerApp>, isSecretMissing: boolean) {
	if (isSecretMissing) {
		return context.json(
			{ error: "WORKER_AUTH_SECRET is not configured on the Worker", code: WorkerAuthErrorCode.SECRET_MISSING },
			503,
		);
	}
	return context.json({ error: "Unauthorized", code: WorkerAuthErrorCode.UNAUTHORIZED }, 401);
}

/**
 * Fails closed: without `WORKER_AUTH_SECRET` every control route answers 503. The transcode runner uploads its outputs
 * with the same secret, and a job's `callbackUrl` receives it as its bearer.
 */
function workerSecretMiddleware(): MiddlewareHandler<WorkerApp> {
	return async (context, next) => {
		const { method, path } = context.req;
		const authHeader = context.req.header("Authorization");
		const secret = context.env.WORKER_AUTH_SECRET;
		const hasWorkerSecret = isBearerAuthorized(secret, authHeader);
		updateRequestState(context, {
			runnerCredential: secret ?? "",
			...(hasWorkerSecret ? { access: { authenticated: true } } : {}),
		});

		if (isOpenRoute(method, path)) {
			// The backend reads private media with its own credential, no viewer token needed.
			if (hasWorkerSecret && path.startsWith(MEDIA_PREFIX))
				updateRequestState(context, { access: { trustedRead: true } });
			await next();
			return;
		}
		if (isUploadUrl(path) || hasWorkerSecret) {
			await next();
			return;
		}
		if (!secret) return rejectUnauthenticated(context, true);

		const grant: UploadGrant | null =
			method === "POST" && path === UPLOAD_CREATE_PATH ? await uploadGrantFromBearer(context, authHeader) : null;
		if (!grant) return rejectUnauthenticated(context, false);
		updateRequestState(context, { access: { authenticated: true, uploadGrant: grant } });
		await next();
	};
}

/** The default authentication: `Authorization: Bearer <WORKER_AUTH_SECRET>` on control routes. */
export function workerSecretAuth(): WorkerPlugin {
	return { name: "worker-secret-auth", middleware: { auth: [workerSecretMiddleware()] } };
}
