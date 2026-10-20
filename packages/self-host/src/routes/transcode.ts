import {
	extractId,
	generateId,
	resolveSecurity,
	resolveTranscodePreset,
	type SecurityPolicy,
	TokenScope,
	TranscodeStatus,
	videoBasePath,
	videoHlsPath,
	videoMp4Dir,
	videoPosterPath,
	videoStoryboardDir,
	videoThumbnailPath,
	visibilityFromKey,
} from "@devultur/core";
import { Hono } from "hono";
import {
	KV_JOB_TTL_SECONDS,
	KvPrefix,
	SERVICE_SUBJECT_PREFIX,
	SERVICE_TOKEN_TYPE,
	signViewerToken,
	storageKey,
} from "../helpers";
import { assertRetranscodable } from "../object-lock/overwrite";
import { cappedExpiry, decideCredential, withPluginClaims } from "../plugin-hooks";
import { getRequestState } from "../request-state";
import { audienceClaim, scopeClaim } from "../token-claims";
import { signJobTicket } from "../transcode/job-ticket";
import { saveOutputBaseUrl } from "../transcode/outputs-report";
import { planTranscode } from "../transcode/plan";
import { hasPriorTranscodeOutputs, ORIGINAL_NOT_RETAINED, rememberRawDisposal } from "../transcode/raw-retention";
import { TranscodeLaunchErrorCode } from "../transcode/runner";
import { createRunner } from "../transcode/runners";
import { buildScript } from "../transcode/script";
import { readStatus, writeQueuedStatus } from "../transcode/status";
import { presetToMaxResolution } from "../transcode-ladder";
import {
	MaxResolution,
	type TranscodeDurationMeta,
	type TranscodeJobMeta,
	type TranscodeRequest,
	type WorkerApp,
} from "../types";
import { clientWebhookFor, clientWebhookKvKey } from "./webhooks";

// Per-resource security override, stored in the raw's metadata (JSON). Undefined if there isn't one.
function parseSecurityMeta(raw: string | undefined): SecurityPolicy | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as SecurityPolicy;
	} catch {
		return undefined;
	}
}

// Lifetime of the token the runner uses to download the original.
const SERVICE_TOKEN_TTL_SECONDS = 3600;

// `extractId` returns the whole key when it doesn't have the `…/video/{id}/…` shape.
const isVideoId = (videoId: string, key: string) => Boolean(videoId) && videoId !== key;

const transcode = new Hono<WorkerApp>();

transcode.post("/", async (context) => {
	const body = await context.req.json<TranscodeRequest>();

	if (!body.key) {
		return context.json({ error: "key is required" }, 400);
	}

	const videoId = extractId(body.key);
	// The renditions/thumbnail live in the SAME visibility folder as the raw (`{visibility}/video/{id}/`).
	// Without this prefix, the HLS/thumbnail get written to `video/{id}/…` but delivery looks for them under
	// `{visibility}/video/{id}/…` → 404 after transcoding. Visibility is derived from the input key.
	const visibility = visibilityFromKey(body.key) ?? "private";
	const outputPrefix = `${visibility}/${videoHlsPath(videoId)}/`;
	const thumbnailKey = `${visibility}/${videoThumbnailPath(videoId)}`;

	const fullKey = storageKey(context, body.key);
	const object = await context.env.MEDIA_BUCKET.head(fullKey);
	if (!object) {
		// Re-transcode of a video whose original is no longer retained (`deleteOriginalOnSuccess`): an explicit error.
		// The video exists if ANY prior output survived (HLS, a standalone MP4, poster…), not just the HLS playlist.
		const videoFolder = storageKey(context, `${visibility}/${videoBasePath(videoId)}/`);
		const isKnownVideo =
			isVideoId(videoId, body.key) && (await hasPriorTranscodeOutputs(context.env.MEDIA_BUCKET, videoFolder));
		if (isKnownVideo) return context.json(ORIGINAL_NOT_RETAINED, 410);
		return context.json({ error: "Media not found in storage" }, 404);
	}

	if (!isVideoId(videoId, body.key)) {
		return context.json({ error: "Invalid key format" }, 400);
	}
	const retained = await assertRetranscodable(context, `${visibility}/${videoBasePath(videoId)}`, object);
	if (retained) return retained;

	// Preset: the request's (name or inline spec, strictly validated) → the config's default → `hls-720p`.
	const scope = getRequestState(context);
	const transcodeConfig = scope.config?.transcode;
	const resolved = resolveTranscodePreset(body.preset, transcodeConfig?.presets);
	if (!resolved.ok) {
		return context.json({ error: "Invalid preset", details: resolved.errors }, 400);
	}
	const preset = resolved.name;
	// The rungs' cap comes from the scope (`config.transcode.maxResolution`). When unset, an alias derives the cap
	// from its name, and a spec gets whatever it declares (4k cap).
	const fallbackMaxResolution = resolved.source === "legacy" ? presetToMaxResolution(preset) : MaxResolution.P4K;
	const maxResolution = transcodeConfig?.maxResolution ?? fallbackMaxResolution;
	// The `hls-*` aliases keep the usual `transcode.complete`; a config preset, a template, or an inline spec also
	// report their outputs (renditions, poster, audio).
	const plan = planTranscode(resolved.spec, maxResolution, { reportsOutputs: resolved.source !== "legacy" });
	// Standalone poster and MP4, in the same visibility folder as the raw and the renditions.
	const posterKey = `${visibility}/${videoPosterPath(videoId)}`;
	const mp4Prefix = `${visibility}/${videoMp4Dir(videoId)}/`;
	const storyboardPrefix = `${visibility}/${videoStoryboardDir(videoId)}/`;
	const workerBaseUrl = new URL(context.req.url).origin;
	const callbackUrl = `${workerBaseUrl}/v1/webhooks/transcode`;

	// L4 video: if the resource's policy (override in the raw's metadata → config default) requests
	// `encrypt` and the video is private, we generate the AES-128 key here, store it in the keys bucket, and
	// pass it to the script (base64 via env). FFmpeg encrypts the segments (CBC) via -hls_key_info_file
	// and bakes `#EXT-X-KEY:URI="{keyId}.key"` into the playlist; hls.js requests that key with a token and decrypts.
	// Resource binding override (from the raw). It's propagated to derived assets (segments/playlist/
	// thumbnail via header) and to the HLS key's metadata, so the gate ties the video per-resource.
	const rawOverride = parseSecurityMeta(object.customMetadata?.security);
	const resourceSecurityHeader = rawOverride ? JSON.stringify(rawOverride) : "";
	const keyMetadata = rawOverride ? { security: resourceSecurityHeader } : undefined;

	const policy = resolveSecurity(rawOverride, scope.config?.security);
	const shouldEncrypt = policy.encrypt && visibility === "private" && Boolean(context.env.KEYS_BUCKET);
	let encryptKeyB64 = "";
	let encryptKeyId = "";
	if (shouldEncrypt && context.env.KEYS_BUCKET) {
		const rawKey = crypto.getRandomValues(new Uint8Array(16));
		encryptKeyId = generateId();
		// The HLS key is an object in the keys bucket at `${storageKey(hls/{keyId})}` — the `.key` endpoint's
		// delivery derives the SAME path from the request (without recomposing the storage prefix).
		const keyPath = storageKey(context, `${outputPrefix}${encryptKeyId}`);
		await context.env.KEYS_BUCKET.put(keyPath, rawKey, {
			...(keyMetadata ? { customMetadata: keyMetadata } : {}),
		});
		encryptKeyB64 = btoa(String.fromCharCode(...rawKey));
	}

	// Download token to fetch the raw: the delivery gate requires a valid viewer token for private
	// media (the upload credential is NOT one). This short-lived service token, WITHOUT binding (the
	// transcode machine has a different UA/IP), passes the gate and the worker decrypts the raw if it's encrypted. For public video the gate ignores it (tokenless delivery).
	const nowSeconds = Math.floor(Date.now() / 1000);
	const requestedExp = nowSeconds + SERVICE_TOKEN_TTL_SECONDS;
	const decision = await decideCredential(context, {
		kind: "service",
		scopes: [TokenScope.MEDIA_READ],
		path: body.key,
		expiresAt: requestedExp * 1000,
	});
	if (!decision.allow) return decision.response;
	const downloadToken = await signViewerToken(
		withPluginClaims(
			{
				sub: `${SERVICE_SUBJECT_PREFIX}${videoId}`,
				typ: SERVICE_TOKEN_TYPE,
				...scopeClaim([TokenScope.MEDIA_READ]),
				...audienceClaim(scope.storagePrefix),
				bind: { sessionBinding: false, ipBinding: false },
				iat: nowSeconds,
				exp: cappedExpiry(requestedExp, decision.expiresAt, (epochMs) => Math.floor(epochMs / 1000)),
			},
			decision,
		),
		context.env.DELIVERY_SIGN_SECRET,
	);

	if (body.callbackUrl) {
		await context.env.MEDIA_KV.put(
			clientWebhookKvKey(videoId),
			JSON.stringify(clientWebhookFor(scope, body.callbackUrl)),
			{ expirationTtl: KV_JOB_TTL_SECONDS },
		);
	}

	const transcodeScript = buildScript({
		videoId,
		maxResolution,
		plan,
		outputPrefix,
		thumbnailKey,
		posterKey,
		mp4Prefix,
		storyboardPrefix,
		encrypt: shouldEncrypt,
	});

	// The runner echoes this ticket on every callback: the webhook knows which job (and whose request) it belongs to
	// without anything stored per job.
	const { ticket: jobTicket } = await signJobTicket(context.env.DELIVERY_SIGN_SECRET, {
		videoId,
		...(scope.context ? { context: scope.context } : {}),
	});

	const runner = createRunner(context.env);
	if (!runner) {
		console.error(`[transcode] unknown TRANSCODE_RUNNER "${context.env.TRANSCODE_RUNNER}"`);
		return context.json({ error: "Invalid TRANSCODE_RUNNER", code: TranscodeLaunchErrorCode.NOT_CONFIGURED }, 500);
	}

	const launch = await runner.launch({
		videoId,
		script: transcodeScript,
		env: {
			INPUT_KEY: body.key,
			VIDEO_ID: videoId,
			OUTPUT_PREFIX: outputPrefix,
			THUMBNAIL_KEY: thumbnailKey,
			WORKER_URL: workerBaseUrl,
			UPLOAD_CREDENTIAL: scope.runnerCredential ?? "",
			CALLBACK_URL: callbackUrl,
			CALLBACK_SECRET: context.env.TRANSCODE_WEBHOOK_SECRET ?? "",
			JOB_TICKET: jobTicket,
			PRESET: preset,
			// Service token to download the raw (private → the gate requires a viewer token; public ignores it).
			DOWNLOAD_TOKEN: downloadToken,
			// L4: HLS encryption material (empty if the video isn't encrypted). The script writes the keyfile
			// from KEY_B64 and bakes `#EXT-X-KEY:URI="$KEY_ID.key"`. The key already lives in the keys bucket.
			KEY_B64: encryptKeyB64,
			KEY_ID: encryptKeyId,
			// Resource binding override (empty if there isn't one) → the script propagates it as a header on
			// every derived asset upload so the gate ties the video per-resource, same as the raw.
			RESOURCE_SECURITY: resourceSecurityHeader,
			// Measurement: the script reports `encodeSeconds` and this vCPU count in `transcode.complete`.
			TRANSCODE_CPUS: String(runner.cpus),
			TRANSCODE_RUNNER: runner.name,
		},
	});
	if (!launch.ok) {
		// `detail` is the provider's body/exception (it can carry account ids and quotas): log only.
		console.error(`[transcode] ${runner.name} launch failed (${launch.code}):`, launch.detail);
		return context.json({ error: launch.error, code: launch.code }, launch.status);
	}
	const jobId = launch.jobRef;

	await Promise.all([
		context.env.MEDIA_KV.put(
			`${KvPrefix.TRANSCODE_JOB}:${jobId}`,
			JSON.stringify({ videoId, inputKey: body.key, outputPrefix, thumbnailKey, preset, runner: runner.name }),
			{ expirationTtl: KV_JOB_TTL_SECONDS },
		),
		writeQueuedStatus(context.env.MEDIA_KV, videoId, { jobRef: jobId, runner: runner.name }),
		// Webhook URLs from `outputBaseUrl` (or the request's origin), fixed when the job is queued.
		saveOutputBaseUrl(context.env.MEDIA_KV, videoId, transcodeConfig?.outputBaseUrl ?? workerBaseUrl),
		rememberRawDisposal(context.env.MEDIA_KV, videoId, {
			storageKey: fullKey,
			deleteOnComplete: transcodeConfig?.deleteOriginalOnSuccess === true,
		}),
	]);

	return context.json({
		jobId,
		videoId,
		inputKey: body.key,
		outputPrefix,
		thumbnailKey,
		preset,
		status: TranscodeStatus.QUEUED,
	});
});

// State comes from the script's webhooks (status.ts), never from the provider's machine.
transcode.get("/:jobId", async (context) => {
	const jobId = context.req.param("jobId");
	const kv = context.env.MEDIA_KV;

	const jobMeta = await kv.get<TranscodeJobMeta>(`${KvPrefix.TRANSCODE_JOB}:${jobId}`, "json");
	if (!jobMeta?.videoId) return context.json({ error: "Job not found" }, 404);

	const [record, durationMeta] = await Promise.all([
		readStatus(kv, jobMeta.videoId),
		kv.get<TranscodeDurationMeta>(`${KvPrefix.TRANSCODE_META}:${jobMeta.videoId}`, "json"),
	]);
	// A record from a different job (a later re-transcode) or from before status.ts → we only know whether it completed.
	const ownRecord = record?.jobRef === jobId ? record : null;
	const status = ownRecord?.status ?? (durationMeta ? TranscodeStatus.COMPLETED : TranscodeStatus.QUEUED);

	if (status === TranscodeStatus.FAILED) {
		const { error, reason, retriable } = ownRecord ?? {};
		return context.json({ jobId, status, error, reason, retriable });
	}
	if (status !== TranscodeStatus.COMPLETED) return context.json({ jobId, status });

	return context.json({
		jobId,
		status,
		duration: durationMeta?.duration ?? null,
		playlistUrl: jobMeta.outputPrefix ? `${jobMeta.outputPrefix}playlist.m3u8` : null,
		thumbnailKey: jobMeta.thumbnailKey ?? null,
	});
});

export { transcode };
