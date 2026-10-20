import { MediaType, resolveSecurity, resolveVisibility, type SecurityPolicy, UploadRequestKind } from "@devultur/core";
import { Hono } from "hono";
import {
	contentDispositionInline,
	encryptForStorage,
	isContentTypeAllowed,
	parseSecurityHeader,
	RESOURCE_SECURITY_HEADER,
	shouldEncryptAtRest,
	storageKey,
	UPLOAD_TOKEN_TTL_SECONDS,
} from "../helpers";
import { resolveUploadLock } from "../object-lock/upload-lock";
import { assetUploadConflict, failedWrite, prepareUploadWrite } from "../object-lock/upload-write";
import { getRequestState, isAuthenticated } from "../request-state";
import type { RawStorageClass, UploadPending, UploadRequest, WorkerApp } from "../types";
import {
	allowedUploadMetadata,
	digestBody,
	discardStaleVariants,
	headerSha256,
	integrityMetadata,
	lockMetadata,
	sha256Mismatch,
	targetFailure,
} from "./upload-integrity";
import {
	handleMultipartAbort,
	handleMultipartPart,
	handleMultipartPost,
	invalidMultipartRequest,
	uploadRequestKindOf,
} from "./upload-multipart";
import {
	lookupUploadPending,
	newUploadPendingId,
	uploadNotFound,
	uploadPendingKvKey,
	uploadUrlFor,
} from "./upload-pending";
import {
	claimTokenFileSlot,
	effectiveMaxBytes,
	inferMediaType,
	isUploadTargetError,
	resolveDeclaredSha256,
	resolveExpiresAt,
	resolveObjectCacheControl,
	resolveUploadTarget,
} from "./upload-target";

const upload = new Hono<WorkerApp>();

upload.post("/", async (context) => {
	const body = await context.req.json<UploadRequest>();
	const isAssetRequest = body.path !== undefined;
	const filename = body.filename ?? (typeof body.path === "string" ? body.path.split("/").pop() : undefined);

	if (!filename || !body.contentType) {
		return context.json({ error: "filename and contentType are required" }, 400);
	}

	const inferredType = inferMediaType(body.contentType);
	// A declared `mediaType` that CONTRADICTS the content type is an inconsistent request → 400. This stops
	// the client from picking another type's rule/path (e.g. declaring `video` with an `image/png` to dodge
	// the image rule, or having a PNG end up on the video path). If the content type can't be inferred
	// (text/*, audio/*, …), the declared one is used — there's nothing to compare it against.
	if (body.mediaType && inferredType && body.mediaType !== inferredType) {
		return context.json(
			{
				error: `mediaType "${body.mediaType}" does not match content type ${body.contentType}`,
				code: "media_type_mismatch",
			},
			400,
		);
	}
	// An asset (client path) accepts any content type: if it can't be inferred, the `file` rule applies.
	const mediaType = body.mediaType ?? inferredType ?? (isAssetRequest ? MediaType.FILE : null);
	if (!mediaType) {
		return context.json({ error: `Unsupported content type: ${body.contentType}` }, 400);
	}

	// Upload rules from the config. `mediaType` is already tied to the
	// content type (or it couldn't be inferred), so rule, path and kind use the same type. The
	// `accept` check happens here (fail-fast, before uploading bytes); `maxSizeBytes` is enforced in the PUT.
	const scope = getRequestState(context);
	const uploadRule = scope.config?.uploadRules?.[mediaType];
	if (!isContentTypeAllowed(body.contentType, uploadRule?.accept)) {
		return context.json(
			{ error: `Content type ${body.contentType} is not allowed`, code: "content_type_not_allowed" },
			415,
		);
	}

	// Visibility: per-upload override → config default for this type → `private`
	// (secure-by-default). It goes FIRST in the key so the worker can gate delivery in O(1). An upload token pins it.
	const grant = scope.access?.uploadGrant;
	const target = resolveUploadTarget(
		body,
		mediaType,
		resolveVisibility(body.visibility, uploadRule?.visibility),
		grant,
	);
	if (isUploadTargetError(target)) return targetFailure(context, target);
	const expiresAt = resolveExpiresAt(body.expiresIn, grant, Date.now(), scope.config?.maxFileLifetimeSeconds);
	if (isUploadTargetError(expiresAt)) return targetFailure(context, expiresAt);
	const sha256 = resolveDeclaredSha256(body.sha256);
	if (isUploadTargetError(sha256)) return targetFailure(context, sha256);
	const cacheControl = resolveObjectCacheControl(body.cacheControl, target, scope.config?.cacheRules);
	if (isUploadTargetError(cacheControl)) return targetFailure(context, cacheControl);
	const lock = resolveUploadLock({
		lock: body.lock,
		hold: body.hold,
		grant,
		appDefault: scope.config?.lock,
		now: Date.now(),
		expiresAt,
	});
	if (isUploadTargetError(lock)) return targetFailure(context, lock);

	const maxSizeBytes = effectiveMaxBytes(uploadRule?.maxSizeBytes, grant);
	const declaredSize = Number(body.size);
	if (maxSizeBytes != null && Number.isFinite(declaredSize) && declaredSize > maxSizeBytes) {
		return context.json({ error: "File exceeds the allowed size", code: "file_too_large", limit: maxSizeBytes }, 413);
	}

	const virtualKey = target.key;
	const fullKey = storageKey(context, virtualKey);
	const shouldOverwrite = body.overwrite === true;
	// Fail-fast (taken asset, locked object): the PUT/complete re-check anyway (the single PUT is conditional in R2).
	const conflict = target.isAsset ? await assetUploadConflict(context, virtualKey, fullKey, shouldOverwrite) : null;
	if (conflict) return conflict;
	if (grant) {
		const exhausted = await claimTokenFileSlot(context.env.MEDIA_KV, grant);
		if (exhausted) return targetFailure(context, exhausted);
	}

	// The PUT that uploads the bytes is credential-less (capability URL) → it has NO config policy in
	// context. We resolve it here (upload override ⊕ config default) and
	// persist it in the pending record, so the PUT applies the right `encrypt`/binding. Without
	// this the PUT would fall back to the default (encrypt off) → storing plaintext even if the config had
	// "encryption at rest" ON (encrypt is decided in the PUT, not in delivery like the binding is).
	const resolvedSecurity = resolveSecurity(body.security, scope.config?.security);

	const pending: UploadPending = {
		contentType: body.contentType,
		storageKey: fullKey,
		key: virtualKey,
		originalFilename: filename,
		security: resolvedSecurity,
		...(maxSizeBytes != null ? { maxSizeBytes } : {}),
		...(scope.context ? { context: scope.context } : {}),
		// Only the video raw: image/file and the transcode assets always go in Standard.
		...(mediaType === MediaType.VIDEO && scope.config?.originalStorageClass
			? { storageClass: scope.config.originalStorageClass }
			: {}),
		...(sha256 ? { sha256 } : {}),
		...(expiresAt ? { expiresAt } : {}),
		...(target.isAsset ? { isAsset: true, overwrite: shouldOverwrite } : {}),
		...(cacheControl ? { cacheControl } : {}),
		...(scope.config?.uploadMetadata ? { uploadMetadata: scope.config.uploadMetadata } : {}),
		...(lock ? { lock } : {}),
	};
	// Keyed by a random id that only the returned URL carries (see upload-pending.ts), never by the key itself.
	const pendingId = newUploadPendingId();
	await context.env.MEDIA_KV.put(uploadPendingKvKey(pendingId), JSON.stringify(pending), {
		expirationTtl: UPLOAD_TOKEN_TTL_SECONDS,
	});

	// We return the fields the client uses to assemble the `DevulturMedia` (id/kind/visibility);
	// filename + width/height are already on the client (captured in the browser).
	return context.json({
		key: virtualKey,
		uploadUrl: uploadUrlFor(virtualKey, pendingId),
		id: target.id,
		kind: mediaType,
		visibility: target.visibility,
		...(expiresAt ? { expiresAt } : {}),
	});
});

// Multipart (large files): same capability URL, the protocol is carried in the query (see core/multipart.ts).
upload.post("/:key{.+}", handleMultipartPost);
upload.delete("/:key{.+}", handleMultipartAbort);

upload.put("/:key{.+}", async (context) => {
	const kind = uploadRequestKindOf(context);
	if (kind === UploadRequestKind.INVALID) return invalidMultipartRequest(context);
	if (kind === UploadRequestKind.MULTIPART_PART) return handleMultipartPart(context);
	const key = context.req.param("key");
	const resolved = await lookupUploadPending(context, key);
	// A pending id that does not resolve is a 404, credential or not. Without a credential the URL is only a
	// capability: it needs the pending of an authenticated POST.
	if (resolved === null || (!resolved && !isAuthenticated(context))) return uploadNotFound(context);
	const pending: UploadPending | null = resolved?.pending ?? null;

	const finalStorageKey = pending?.storageKey ?? storageKey(context, key);
	const expectedContentType = pending?.contentType ?? null;
	const originalFilename = pending?.originalFilename ?? null;
	const maxSizeBytes = pending?.maxSizeBytes ?? null;
	const storageClass: RawStorageClass = pending?.storageClass ?? "Standard";
	// Resource security override: from the pending record (client upload) or the header (transcode
	// uploads, which propagate the raw's override to segments/playlist/thumbnail). It's persisted as
	// metadata so the gate can resolve it per-resource. The header is trusted (it's equivalent to the
	// `security` override the upload POST already accepts): only an authorized upload can set it, and it only
	// affects the security of ITS OWN resource → it's not an escalation.
	const resourceSecurity: SecurityPolicy | undefined =
		pending?.security ?? parseSecurityHeader(context.req.header(RESOURCE_SECURITY_HEADER));

	const contentType = context.req.header("Content-Type") ?? "application/octet-stream";

	if (expectedContentType && contentType !== expectedContentType) {
		return context.json({ error: `Expected Content-Type ${expectedContentType}, got ${contentType}` }, 400);
	}

	// Size gate on the real content-length (the effective cap from the config rule, resolved in the
	// POST). Checked BEFORE buffering the body so we don't load into memory a file we're going to reject.
	const declaredSize = Number(context.req.header("content-length") ?? "0");
	if (maxSizeBytes != null && Number.isFinite(declaredSize) && declaredSize > maxSizeBytes) {
		return context.json(
			{ error: "File exceeds the allowed size for this media type", code: "file_too_large", limit: maxSizeBytes },
			413,
		);
	}

	const body = await context.req.arrayBuffer();

	// Backstop on the REAL bytes: content-length can be missing or lie (streamed body). We've
	// already buffered the body to store it, so revalidating `byteLength` is free and closes the
	// missing/spoofed header bypass.
	if (maxSizeBytes != null && body.byteLength > maxSizeBytes) {
		return context.json(
			{ error: "File exceeds the allowed size for this media type", code: "file_too_large", limit: maxSizeBytes },
			413,
		);
	}

	// sha256 of the PLAINTEXT (before encryption): what's declared (POST or header) must match the bytes.
	const digest = await digestBody(body, pending?.sha256, headerSha256(context));
	if ("invalid" in digest) {
		return context.json({ error: "x-devultur-sha256 must be a 64-character hex string", code: "invalid_sha256" }, 400);
	}
	if ("mismatch" in digest) return sha256Mismatch(context, digest.mismatch.expected, digest.mismatch.actual);

	// Effective resource policy (upload override → config default → secure-default). The
	// binding is persisted as metadata so the gate can read it per-resource; `encrypt` decides whether
	// we encrypt the body here. ANY private asset gets encrypted at rest EXCEPT the HLS segments/playlists
	// (`.ts`/`.m3u8`): those are already AES-128 encrypted by the transcode and hls.js decrypts them client-side —
	// re-encrypting them would break playback. This covers image/file + the video raw and thumbnail.
	const policy = resolveSecurity(resourceSecurity, getRequestState(context).config?.security);
	const shouldEncrypt = shouldEncryptAtRest(policy, key, Boolean(context.env.KEYS_BUCKET));

	const customMetadata: Record<string, string> = {
		...allowedUploadMetadata(pending?.uploadMetadata ?? getRequestState(context).config?.uploadMetadata),
		...integrityMetadata(digest.sha256, true, pending?.expiresAt),
		...lockMetadata(pending?.lock),
	};
	// The binding override travels in the metadata → the delivery gate resolves it per-resource.
	if (resourceSecurity) customMetadata.security = JSON.stringify(resourceSecurity);
	// Locks and create-only before any side effect (the encryption key below): the put is pinned to what this saw.
	const write = await prepareUploadWrite(context, pending?.key ?? key, pending, finalStorageKey);
	if ("blocked" in write) return write.blocked;

	let storedBody: ArrayBuffer | Uint8Array = body;
	if (shouldEncrypt && context.env.KEYS_BUCKET) {
		// The key lives under the object's storage key (`${finalStorageKey}/${keyId}`) → delivery derives
		// the SAME object path without recomposing the storage prefix. The binding override also travels
		// in the key's metadata so the `.key` endpoint (HLS) can resolve it per-resource.
		const result = await encryptForStorage(context.env.KEYS_BUCKET, finalStorageKey, body, customMetadata);
		storedBody = result.body;
		customMetadata.enc = result.enc;
	}

	// Conditional put (R2 returns null when the object changed or appeared since the check) → 409.
	const stored = await context.env.MEDIA_BUCKET.put(finalStorageKey, storedBody, {
		onlyIf: write.onlyIf,
		// Standard except for the video raw when the config retains it ≥30 days (Infrequent Access, see
		// `RAW_STORAGE_CLASS`): IA has a 30-day minimum and charges retrieval ($0.01/GB) on every read — the
		// transcode's read, and the direct MP4 delivery if it isn't transcoded. With retention `off` the raw lives
		// for minutes.
		storageClass,
		httpMetadata: {
			contentType,
			...(originalFilename ? { contentDisposition: contentDispositionInline(originalFilename) } : {}),
			...(pending?.cacheControl ? { cacheControl: pending.cacheControl } : {}),
		},
		...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
	});

	if (stored === null) return failedWrite(context, key, pending, customMetadata.enc);

	if (resolved) await context.env.MEDIA_KV.delete(resolved.kvKey);
	await discardStaleVariants(context.env.MEDIA_BUCKET, pending);

	return context.json({ key, size: body.byteLength, sha256: digest.sha256, sha256Verified: true });
});

export { upload };
