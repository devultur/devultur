import {
	captionPath,
	createDecryptStream,
	decodeEncryptionMeta,
	extractId,
	type MediaEvent,
	resolveSecurity,
	visibilityFromKey,
} from "@devultur/core";
import { type Context, Hono } from "hono";
import {
	areLocalesAllowed,
	encryptForStorage,
	KV_JOB_TTL_SECONDS,
	KvPrefix,
	loadStorageKey,
	parseSecurityHeader,
	storageKey,
} from "../helpers";
import { isKeysBucketMissing, keysBucketMissing } from "../keys-bucket";
import { emitProcessingEvent } from "../media-events/emit";
import { captionConflictResponse, prepareCaptionWrites } from "../object-lock/caption-writes";
import { getRequestState } from "../request-state";
import type {
	CaptionJobMeta,
	CaptionsRequest,
	GroqTranscriptResponse,
	GroqTranscriptWord,
	MistralChatResponse,
	WorkerApp,
} from "../types";
import { CaptionsProviderError, logCaptionsError, toCaptionsFailure } from "./captions-errors";
import { clientWebhookFor, forwardToClientWebhook, getWebhookData, type WebhookData } from "./webhooks";

const GROQ_API = "https://api.groq.com/openai/v1";
const MISTRAL_API = "https://api.mistral.ai/v1";

const LANGUAGE_NAMES: Record<string, string> = {
	en: "English",
	es: "Spanish",
	fr: "French",
	pt: "Portuguese",
	de: "German",
	it: "Italian",
	ja: "Japanese",
	ko: "Korean",
	zh: "Chinese",
	ar: "Arabic",
	hi: "Hindi",
	ru: "Russian",
	nl: "Dutch",
	sv: "Swedish",
	pl: "Polish",
	tr: "Turkish",
	vi: "Vietnamese",
	th: "Thai",
	uk: "Ukrainian",
	id: "Indonesian",
};

function getLanguageName(code: string): string {
	return LANGUAGE_NAMES[code] ?? code;
}

function formatTimestamp(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 1000);
	return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

function wordsToSentenceVtt(words: GroqTranscriptWord[]): string {
	const cues: { start: number; end: number; text: string }[] = [];
	let sentenceWords: GroqTranscriptWord[] = [];

	for (const word of words) {
		sentenceWords.push(word);
		if (/[.!?]$/.test(word.word)) {
			cues.push({
				start: sentenceWords[0].start,
				end: word.end,
				text: sentenceWords.map((w) => w.word).join(" "),
			});
			sentenceWords = [];
		}
	}

	if (sentenceWords.length > 0) {
		cues.push({
			start: sentenceWords[0].start,
			end: sentenceWords[sentenceWords.length - 1].end,
			text: sentenceWords.map((w) => w.word).join(" "),
		});
	}

	const lines = ["WEBVTT", ""];
	for (const cue of cues) {
		lines.push(`${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}`);
		lines.push(cue.text.trim());
		lines.push("");
	}
	return lines.join("\n");
}

function findSourceLocale(detectedLang: string, locales: string[]): string {
	return locales.find((l) => l.split("-")[0] === detectedLang) ?? locales[0];
}

function cleanVttResponse(response: string): string {
	let vtt = response.trim();
	if (vtt.startsWith("```")) {
		vtt = vtt.replace(/^```(?:vtt|webvtt)?\n?/, "").replace(/\n?```$/, "");
	}
	if (!vtt.startsWith("WEBVTT")) {
		vtt = `WEBVTT\n\n${vtt}`;
	}
	return vtt;
}

async function transcribeWithGroq(
	providerKey: string,
	audioBody: ReadableStream,
	filename: string,
): Promise<GroqTranscriptResponse> {
	const blob = new Blob([await new Response(audioBody).arrayBuffer()]);
	const formData = new FormData();
	formData.append("file", blob, filename);
	formData.append("model", "whisper-large-v3-turbo");
	formData.append("response_format", "verbose_json");
	formData.append("timestamp_granularities[]", "word");

	const response = await fetch(`${GROQ_API}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${providerKey}` },
		body: formData,
	});

	if (!response.ok) {
		throw new CaptionsProviderError("groq", response.status, await response.text());
	}

	return (await response.json()) as GroqTranscriptResponse;
}

async function translateVtt(providerKey: string, sourceVtt: string, targetLocale: string): Promise<string> {
	const targetLang = targetLocale.split("-")[0];
	const targetName = getLanguageName(targetLang);

	const response = await fetch(`${MISTRAL_API}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${providerKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "mistral-small-latest",
			messages: [
				{
					role: "user",
					content: [
						`Translate the following WebVTT subtitle file to ${targetName} (${targetLocale}).`,
						"Rules:",
						"- Keep the WEBVTT header and ALL timestamps exactly as-is",
						"- Only translate the spoken text between timestamp lines",
						"- Do not add or remove any cues",
						"- Return ONLY the complete translated VTT file, no commentary",
						"",
						sourceVtt,
					].join("\n"),
				},
			],
		}),
	});

	if (!response.ok) {
		throw new CaptionsProviderError("mistral", response.status, await response.text());
	}

	const result = (await response.json()) as MistralChatResponse;
	return cleanVttResponse(result.choices[0].message.content);
}

// Client webhook destination for this video. Used by both success (captions.complete)
// and failure (captions.failed): an explicit request callback → the one saved in KV → the
// config's fallback. Resolved BEFORE transcribing so it can notify even on failure.
async function resolveCaptionsWebhook(
	context: Context<WorkerApp>,
	videoId: string,
	callbackUrl: string | undefined,
): Promise<WebhookData | null> {
	if (callbackUrl) return clientWebhookFor(getRequestState(context), callbackUrl);
	const stored = await getWebhookData(context.env.MEDIA_KV, videoId);
	return stored;
}

/** Duration (seconds) that the last `transcode.complete` of the video reported, or undefined. */
async function transcodedDuration(kv: KVNamespace, videoId: string): Promise<number | undefined> {
	const meta = await kv.get<{ duration?: number }>(`${KvPrefix.TRANSCODE_META}:${videoId}`, "json");
	return meta?.duration ?? undefined;
}

const captions = new Hono<WorkerApp>();

captions.post("/", async (context) => {
	const body = await context.req.json<CaptionsRequest>();

	if (!body.key || !body.locales?.length) {
		return context.json({ error: "key and locales are required" }, 400);
	}

	// Locale whitelist from the config. Absent = allows everything.
	const scope = getRequestState(context);
	if (!areLocalesAllowed(body.locales, scope.config?.captionsLocales)) {
		return context.json(
			{ error: "One or more requested locales are not allowed by this Worker's config", code: "locale_not_allowed" },
			400,
		);
	}

	const fullKey = storageKey(context, body.key);
	const file = await context.env.MEDIA_BUCKET.get(fullKey);
	if (!file) {
		return context.json({ error: "Media not found in storage" }, 404);
	}

	const videoId = extractId(body.key);
	if (!videoId || videoId === body.key) {
		return context.json({ error: "Invalid key format — expected {type}/{id}/..." }, 400);
	}

	const filename = body.key.split("/").pop() ?? "audio.mp4";
	const webhookData = await resolveCaptionsWebhook(context, videoId, body.callbackUrl);

	// If the raw is encrypted at rest (L4), reading it straight from R2 gives CIPHERTEXT → Groq would transcribe garbage.
	// We decrypt it here (same pattern as delivery) before transcribing. Transcode doesn't suffer this
	// because it downloads the raw through the delivery path (which already decrypts); captions reads the bucket directly.
	const rawEnc = decodeEncryptionMeta(file.customMetadata?.enc);
	let audioBody = file.body;
	if (rawEnc) {
		const loaded = await loadStorageKey(context.env.KEYS_BUCKET, fullKey, rawEnc.keyId);
		if (!loaded) {
			return context.json({ error: "Decryption key unavailable" }, 500);
		}
		audioBody = file.body.pipeThrough(createDecryptStream(loaded.key, rawEnc.iv));
	}

	// The .vtt files live in the same visibility folder as the video (`{visibility}/video/{id}/captions/…`).
	// Without this prefix they'd get written to `video/{id}/…` and delivery looks them up with visibility → 404.
	const visibility = visibilityFromKey(body.key) ?? "private";
	const captionVirtualKey = (locale: string) => `${visibility}/${captionPath(videoId, locale)}`;
	// The .vtt files are private assets of the video → encrypted at rest if the policy asks for it (same criterion
	// as the raw/thumbnail). The video's binding override (audio/raw metadata) propagates to the
	// .vtt's metadata so the gate ties it per-resource. The key lives at `${captionKey}/${keyId}`.
	const resourceOverride = parseSecurityHeader(file.customMetadata?.security);
	const captionPolicy = resolveSecurity(resourceOverride, scope.config?.security);
	const encryptCaptions = Boolean(captionPolicy.encrypt) && visibility === "private";
	// Fail closed before transcribing: never a plaintext .vtt of a video that must be encrypted (keys-bucket.ts).
	if (isKeysBucketMissing(encryptCaptions, context.env)) return keysBucketMissing(context);
	// The captions expire with the media they're made from (same `410` past its `expiresAt`).
	const writes = await prepareCaptionWrites(context, body.locales, captionVirtualKey, file);
	if ("blocked" in writes) return writes.blocked;
	const putCaption = async (locale: string, vtt: string) => {
		const objectKey = writes.storageKeyOf(locale);
		const metadata: Record<string, string> = {};
		if (resourceOverride) metadata.security = JSON.stringify(resourceOverride);
		let bodyToStore: string | Uint8Array = vtt;
		if (encryptCaptions && context.env.KEYS_BUCKET) {
			const result = await encryptForStorage(
				context.env.KEYS_BUCKET,
				objectKey,
				new TextEncoder().encode(vtt),
				metadata,
			);
			bodyToStore = result.body;
			metadata.enc = result.enc;
		}
		await writes.put(locale, bodyToStore, {
			httpMetadata: { contentType: "text/vtt" },
			...(Object.keys(metadata).length > 0 ? { customMetadata: metadata } : {}),
		});
	};

	try {
		const transcript = await transcribeWithGroq(context.env.GROQ_API_KEY, audioBody, filename);

		const sourceVtt = wordsToSentenceVtt(transcript.words);
		const detectedLang = transcript.language.slice(0, 2);
		const sourceLocale = findSourceLocale(detectedLang, body.locales);
		const jobId = crypto.randomUUID();
		const completedLocales: string[] = [];

		await putCaption(sourceLocale, sourceVtt);
		completedLocales.push(sourceLocale);

		const duplicateLocales = body.locales.filter((l) => l !== sourceLocale && l.split("-")[0] === detectedLang);
		for (const locale of duplicateLocales) {
			await putCaption(locale, sourceVtt);
			completedLocales.push(locale);
		}

		const translationLocales = body.locales.filter((l) => l !== sourceLocale && l.split("-")[0] !== detectedLang);

		const translationResults = await Promise.allSettled(
			translationLocales.map(async (locale) => {
				const translatedVtt = await translateVtt(context.env.MISTRAL_API_KEY, sourceVtt, locale);
				await putCaption(locale, translatedVtt);
				return locale;
			}),
		);

		// Only translations that ACTUALLY got generated (fulfilled): duplicates of the source language get
		// copied without translating and failed ones produce nothing → neither counts as a translation.
		const translatedLocales: string[] = [];
		for (const [index, result] of translationResults.entries()) {
			if (result.status === "rejected") {
				logCaptionsError(`translation to ${translationLocales[index]} failed for ${videoId}`, result.reason);
				continue;
			}
			completedLocales.push(result.value);
			translatedLocales.push(result.value);
		}

		// `completedLocales` = what ACTUALLY got generated (source + duplicates + fulfilled translations),
		// not what was requested → the status GET doesn't report failed translations as completed.
		const jobMeta: CaptionJobMeta = { videoId, locales: body.locales, completedLocales, status: "completed" };
		await context.env.MEDIA_KV.put(`${KvPrefix.CAPTION_GROUP}:${jobId}`, JSON.stringify(jobMeta), {
			expirationTtl: KV_JOB_TTL_SECONDS,
		});

		const completed: MediaEvent = { event: "captions.complete", videoId, locales: completedLocales };
		await forwardToClientWebhook(completed, webhookData);
		await emitProcessingEvent(context, completed);

		return context.json({
			transcriptId: jobId,
			inputKey: body.key,
			locales: body.locales,
			completedLocales,
			// Job detail for the caller: source language, effective translations and the audio's duration (the
			// transcription's; without it, the one the last transcode reported, kept in KV for 24 h).
			sourceLocale,
			translatedLocales,
			durationSeconds: transcript.duration ?? (await transcodedDuration(context.env.MEDIA_KV, videoId)),
			status: "completed",
		});
	} catch (err) {
		// Transcription or VTT storage failed → the client gets `captions.failed` instead of
		// hanging waiting for `captions.complete`. The response is a 5xx. The provider's error only goes to the
		// log: the response (with `code`) and the webhook (with `reason`/`retriable`) carry a generic message.
		logCaptionsError(`job failed for ${videoId}`, err);
		const failure = toCaptionsFailure(err);
		const failed: MediaEvent = {
			event: "captions.failed",
			videoId,
			error: failure.error,
			reason: failure.reason,
			retriable: failure.retriable,
		};
		await forwardToClientWebhook(failed, webhookData);
		await emitProcessingEvent(context, failed);
		const conflict = captionConflictResponse(context, err);
		return conflict ?? context.json({ error: failure.error, code: failure.code }, failure.status);
	}
});

captions.get("/:transcriptId", async (context) => {
	const transcriptId = context.req.param("transcriptId");

	const job = await context.env.MEDIA_KV.get<CaptionJobMeta>(`${KvPrefix.CAPTION_GROUP}:${transcriptId}`, "json");

	if (!job) {
		return context.json({ error: "Caption job not found" }, 404);
	}

	return context.json({
		transcriptId,
		status: job.status,
		// The ones actually generated; falls back to `locales` (requested) only for old jobs missing the field.
		completedLocales: job.completedLocales ?? job.locales,
		error: job.error,
	});
});

export { captions };
