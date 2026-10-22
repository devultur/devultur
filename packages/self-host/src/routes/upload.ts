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
import { encryptionKeyMissing, hasEncryptionKey, isKeysBucketMissing, keysBucketMissing } from "../keys-bucket";
import { resolveUploadLock } from "../object-lock/upload-lock";
import {
	afterUploadWrite,
	assetUploadConflict,
	failedWrite,
	prepareUploadWrite,
	uploadLockOf,
} from "../object-lock/upload-write";
import { getRequestState, isAuthenticated } from "../request-state";
import type { RawStorageClass, UploadPending, UploadRequest, WorkerApp } from "../types";
import { inheritedExpiresAt } from "./derived-upload";
import { checkSinglePutContent, OCTET_STREAM } from "./upload-content-check";
import {
	allowedUploadMetadata,
	digestBody,
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
	isUploadTargetError,
	resolveDeclaredSha256,
	resolveExpiresAt,
	resolveObjectCacheControl,
	resolveUploadMediaType,
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

	const mediaType = resolveUploadMediaType(body.mediaType, body.contentType, isAssetRequest);
	if (isUploadTargetError(mediaType)) return targetFailure(context, mediaType);

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
	});
	if (isUploadTargetError(lock)) return targetFailure(context, lock);

	const maxSizeBytes = effectiveMaxBytes(uploadRule?.maxSizeBytes, grant);
	const declaredSize = Number(body.size);
	if (maxSizeBytes != null && Number.isFinite(declaredSize) && declaredSize > maxSizeBytes) {
		return context.json({ error: "File exceeds the allowed size", code: "file_too_large", limit: maxSizeBytes }, 413);
	}

	const virtualKey = target.key;
	const fullKey = storageKey(context, virtualKey);
	// The PUT that uploads the bytes is credential-less (capability URL) → it has NO config policy in context. We resolve
	// it here (upload override ⊕ config default) and persist it in the pending, so the PUT applies the right
	// `encrypt`/binding instead of falling back to the default (encrypt off) and storing plaintext.
	const resolvedSecurity = resolveSecurity(body.security, scope.config?.security);
	// Fail closed before the client sends any bytes or a token's file slot is spent (see keys-bucket.ts).
	if (isKeysBucketMissing(shouldEncryptAtRest(resolvedSecurity, virtualKey), context.env)) {
		return keysBucketMissing(context);
	}
	const shouldOverwrite = body.overwrite === true;
	// Fail-fast (taken asset, locked object): the PUT/complete re-check anyway (the single PUT is conditional in R2).
	const conflict = target.isAsset ? await assetUploadConflict(context, virtualKey, fullKey, shouldOverwrite) : null;
	if (conflict) return conflict;
	if (grant) {
		const exhausted = await claimTokenFileSlot(context.env.MEDIA_KV, grant);
		if (exhausted) return targetFailure(context, exhausted);
	}

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
		...(scope.config?.contentSniffing ? { contentSniffing: scope.config.contentSniffing } : {}),
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

	const declaredContentType = context.req.header("Content-Type") ?? OCTET_STREAM;

	if (expectedContentType && declaredContentType !== expectedContentType) {
		return context.json({ error: `Expected Content-Type ${expectedContentType}, got ${declaredContentType}` }, 400);
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
	// The plaintext's first bytes against the declared type, before anything is written (see upload-content-check.ts).
	const content = checkSinglePutContent(context, { key, pending, contentType: declaredContentType, body });
	if ("rejected" in content) return content.rejected;
	const { contentType } = content;

	// Effective resource policy (upload override → config default → secure-default). The
	// binding is persisted as metadata so the gate can read it per-resource; `encrypt` decides whether
	// we encrypt the body here. ANY private asset gets encrypted at rest EXCEPT the HLS segments/playlists
	// (`.ts`/`.m3u8`): those are already AES-128 encrypted by the transcode and hls.js decrypts them client-side —
	// re-encrypting them would break playback. This covers image/file + the video raw and thumbnail.
	const policy = resolveSecurity(resourceSecurity, getRequestState(context).config?.security);
	const shouldEncrypt = shouldEncryptAtRest(policy, key);
	// Backstop of the POST's check (a PUT without a pending, a binding removed in between): never plaintext.
	if (isKeysBucketMissing(shouldEncrypt, context.env)) return keysBucketMissing(context);

	const customMetadata: Record<string, string> = {
		...allowedUploadMetadata(pending?.uploadMetadata ?? getRequestState(context).config?.uploadMetadata),
		// A transcode output (no pending) expires with its video's raw.
		...integrityMetadata(digest.sha256, true, pending?.expiresAt ?? (await inheritedExpiresAt(context, key))),
		...lockMetadata(uploadLockOf(context, key, pending)),
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

	// A delete of the object this replaces may have swept the key just written: never store what can't be decrypted.
	if (!(await hasEncryptionKey(context.env.KEYS_BUCKET, finalStorageKey, customMetadata.enc))) {
		return encryptionKeyMissing(context, key);
	}

	// Conditional put (R2 returns null when the object changed or appeared since the check) → 409.
	const stored = await context.env.MEDIA_BUCKET.put(finalStorageKey, storedBody, {
		onlyIf: write.onlyIf,
		// Standard, except a video raw the config keeps ≥30 days: Infrequent Access (30-day minimum, and a retrieval
		// charge on every read, the transcode's included; see `RAW_STORAGE_CLASS`).
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
	await afterUploadWrite(context, key, pending, write, customMetadata.enc);

	return context.json({ key, size: body.byteLength, sha256: digest.sha256, sha256Verified: true });
});

export { upload };
