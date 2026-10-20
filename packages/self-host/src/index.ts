import {
	EXPIRES_AT_HEADER,
	REPR_DIGEST_HEADER,
	SESSION_HEADER,
	SHA256_HEADER,
	SHA256_VERIFIED_HEADER,
} from "@devultur/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { rejectReservedLockPaths } from "./object-lock/guard";
import { lockRoute } from "./object-lock/lock-route";
import { composePlugins, type WorkerPlugin } from "./plugin";
import { PLUGIN_HOOKS_VARIABLE } from "./plugin-hooks";
import { defaultPlugins } from "./plugins";
import { assets } from "./routes/assets";
import { captions } from "./routes/captions";
import { media } from "./routes/media";
import { token } from "./routes/token";
import { transcode } from "./routes/transcode";
import { upload } from "./routes/upload";
import { webhooks } from "./routes/webhooks";
import type { WorkerApp } from "./types";

export { DownloadLink, type DownloadLinkRecord, type DownloadLinkStorage } from "./download-link";
export { deletePrefix, hashKey, isServiceToken, storageKey, verifyViewerToken } from "./helpers";
export { imageOriginAuthorization, isImageOriginRequest, readImageOriginScope } from "./image/cloudflare";
export { type ImageTransformParams, parseTransformParams } from "./image/params";
export { isVariantKey, variantPrefix } from "./image/transform-plan";
export { KEYS_BUCKET_MISSING_CODE } from "./keys-bucket";
export { LOCK_AUDIT_PREFIX, type LockAuditAction, type LockAuditRecord } from "./object-lock/audit";
export { LOCK_HOLD_HEADER, LOCK_UNTIL_HEADER } from "./object-lock/delivery";
export { RESERVED_LOCK_PREFIXES } from "./object-lock/guard";
export { HOLD_PAGE_SIZE, type HoldSkip } from "./object-lock/hold";
export { LOCK_SIDECAR_PREFIX, type LockSidecar, type LockSource } from "./object-lock/sidecar";
export { LOCK_METADATA_KEY } from "./object-lock/state";
export type { ComposedPlugins, PluginMiddleware, PluginRoute, WorkerPlugin } from "./plugin";
export type {
	AllowedCredential,
	AuthorizeLockChangeHook,
	BeforeLinkRedeemHook,
	CredentialDecision,
	CredentialKind,
	CredentialRequest,
	IssueCredentialHook,
	LockChangeAction,
	LockChangeDecision,
	LockChangeRequest,
	OnLockAuditHook,
} from "./plugin-hooks";
export {
	type CredentialPolicyOptions,
	credentialPolicy,
	defaultPlugins,
	downloadLinks,
	isOpenRoute,
	isUploadUrl,
	staticConfig,
	WorkerAuthErrorCode,
	workerSecretAuth,
} from "./plugins";
export {
	getRequestState,
	isAuthenticated,
	type Json,
	type PluginContext,
	type RequestAccess,
	type RequestState,
	type RequestStatePatch,
	type TranscodeConfig,
	updateRequestState,
	type WorkerConfig,
} from "./request-state";
export { type DownloadLinkInfo, getRouteResult, type RouteResult, type TranscodeJob } from "./route-result";
export { type AssetListEntry, MAX_ASSET_LIST_LIMIT, MAX_EXPIRED_LOOKUPS } from "./routes/assets";
export { edgeCacheTag } from "./routes/edge-cache";
export { servedCacheControl } from "./routes/media";
export { isObjectExpired } from "./routes/object-response";
export { MAX_UPLOAD_TOKEN_TTL_SECONDS, UPLOAD_TOKEN_TYPE, uploadGrantFromClaims } from "./routes/token-upload";
export { ObjectMeta } from "./routes/upload-integrity";
export { cancelPendingUpload, getPendingUpload, type PendingUploadInfo } from "./routes/upload-pending";
export { TOKEN_REJECTED_CODE } from "./routes/viewer-token-claims";
export { readTokenScopes } from "./token-claims";
export {
	type EncodeMetrics,
	logEncodeMetrics,
	parseEncodeMetrics,
	vcpuSecondsPerVideoMinute,
} from "./transcode/metrics";
export {
	readStoryboardKey,
	readTranscodeOutputKeys,
	readTranscodeOutputs,
	withOutputUrls,
} from "./transcode/outputs-report";
export type {
	RawStorageClass,
	UploadGrant,
	UploadRules,
	UploadTypeRule,
	WorkerApp,
	WorkerEnv,
	WorkerVariables,
} from "./types";
export { MaxResolution } from "./types";

export interface CreateWorkerOptions {
	/** Plugins, composed in order (see plugin.ts). Omitted: `defaultPlugins()`. */
	plugins?: WorkerPlugin[];
}

export function createWorker(options?: CreateWorkerOptions) {
	const { middleware, routes, hooks } = composePlugins(options?.plugins ?? defaultPlugins());
	const app = new Hono<WorkerApp>();

	app.use("*", logger());
	app.use(
		"*",
		cors({
			origin: "*",
			allowMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization", "Range", SESSION_HEADER, SHA256_HEADER],
			exposeHeaders: [SHA256_HEADER, SHA256_VERIFIED_HEADER, REPR_DIGEST_HEADER, EXPIRES_AT_HEADER, "Content-Range"],
		}),
	);
	app.use("*", async (context, next) => {
		context.set(PLUGIN_HOOKS_VARIABLE, hooks);
		await next();
	});
	app.use("/v1/*", rejectReservedLockPaths);
	for (const handler of middleware) app.use("*", handler);

	app.get("/health", (c) => c.json({ status: "ok" }));
	// Playback metrics endpoint of @devultur/react's player: a no-op that answers 204 (a plugin can record them).
	app.post("/v1/metrics/playback", (c) => c.body(null, 204));

	app.route("/v1/webhooks", webhooks);
	app.route("/v1/upload", upload);
	app.route("/v1/media", media);
	app.route("/v1/assets", assets);
	app.route("/v1/transcode", transcode);
	app.route("/v1/captions", captions);
	app.route("/v1/token", token);
	app.route("/v1/lock", lockRoute);
	for (const route of routes) app.route(route.path, route.app);

	app.notFound((c) => c.json({ error: "Not found" }, 404));

	app.onError((err, c) => {
		console.error("Unhandled error:", err);
		return c.json({ error: "Internal server error" }, 500);
	});

	return app;
}
