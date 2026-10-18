// The encode measurement the script attaches to `transcode.complete` (`encode`): how long FFmpeg took, on how many vCPUs
// and which runner, plus the per-title choices. It's for the Worker's operator, to size and compare runners: the Worker
// logs it (`[transcode-metrics]`), a plugin can read it with `parseEncodeMetrics`, and the app's webhook never gets it.

export interface EncodeMetrics {
	/** Wall-clock seconds of the ladder's FFmpeg (no download, upload or thumbnail). */
	encodeSeconds: number;
	/** vCPUs of the runner (0 = unknown). */
	cpus: number;
	/** Duration of the source, in seconds. */
	durationSeconds: number;
	/** Highest rendition generated (`360p`…`4k`). */
	topRung?: string;
	runner?: string;
	/** Per-title encoding: complexity 0 (simple) to 1 (complex). Absent = no probe (short clip, opt-out). */
	complexity?: number;
	/** Wall-clock seconds of the complexity probe. */
	probeSeconds?: number;
	/** CRF and maxrate chosen per rung (rungs at CRF; an MP4 with the spec's bitrate doesn't appear). */
	encodeParams?: EncodeParam[];
}

export interface EncodeParam {
	rung: string;
	crf: number;
	maxrateKbps: number;
}

// Fields of the runner's event that aren't the app's: the operator's measurement, and the poster keys the Worker turns
// into `posterUrls`. The app's handler can validate strictly (reject unknown fields). `storyboardKey` has its own rule
// (outputs-report.ts → withClientStoryboard).
const OPERATOR_EVENT_FIELDS = ["encode", "posterKey", "posterFormats"] as const;

const isNonNegativeNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

function readEncodeParams(value: unknown): EncodeParam[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const params = value.filter((entry): entry is EncodeParam => {
		if (typeof entry !== "object" || entry === null) return false;
		const { rung, crf, maxrateKbps } = entry as Record<string, unknown>;
		return typeof rung === "string" && isNonNegativeNumber(crf) && isNonNegativeNumber(maxrateKbps);
	});
	return params.length > 0 ? params.map(({ rung, crf, maxrateKbps }) => ({ rung, crf, maxrateKbps })) : undefined;
}

// Per-title fields that are present and valid (no `undefined` keys).
function perTitleMetrics(
	encode: Record<string, unknown>,
): Pick<EncodeMetrics, "complexity" | "probeSeconds" | "encodeParams"> {
	const isScore = isNonNegativeNumber(encode.complexity) && encode.complexity <= 1;
	const encodeParams = readEncodeParams(encode.params);
	return {
		...(isScore ? { complexity: encode.complexity as number } : {}),
		...(isNonNegativeNumber(encode.probeSeconds) ? { probeSeconds: encode.probeSeconds } : {}),
		...(encodeParams ? { encodeParams } : {}),
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The encode measurement of a `transcode.complete`. Null if the event doesn't carry it or it's invalid. */
export function parseEncodeMetrics(event: unknown): EncodeMetrics | null {
	if (!isRecord(event) || event.event !== "transcode.complete" || !isRecord(event.encode)) return null;
	const { encode } = event;
	if (!isNonNegativeNumber(encode.seconds) || !isNonNegativeNumber(event.duration)) return null;
	return {
		encodeSeconds: encode.seconds,
		cpus: isNonNegativeNumber(encode.cpus) ? encode.cpus : 0,
		durationSeconds: event.duration,
		topRung: optionalString(encode.topRung),
		runner: optionalString(encode.runner),
		...perTitleMetrics(encode),
	};
}

/** vCPU-seconds per minute of video (assumes the CPU saturated during the encode). Null without vCPUs or duration. */
export function vcpuSecondsPerVideoMinute(metrics: EncodeMetrics): number | null {
	if (metrics.cpus <= 0 || metrics.durationSeconds <= 0) return null;
	return (metrics.encodeSeconds * metrics.cpus) / (metrics.durationSeconds / 60);
}

/** Copy of the event without the operator's fields, ready to forward to the app's webhook. */
export function withoutOperatorFields(event: Record<string, unknown>): Record<string, unknown> {
	const clientEvent = { ...event };
	for (const field of OPERATOR_EVENT_FIELDS) delete clientEvent[field];
	return clientEvent;
}

/** Structured log line (grep `[transcode-metrics]`) to measure vCPU-s/min without extra infrastructure. */
export function logEncodeMetrics(videoId: string, metrics: EncodeMetrics): void {
	const perMinute = vcpuSecondsPerVideoMinute(metrics);
	console.log(
		"[transcode-metrics]",
		JSON.stringify({
			videoId,
			...metrics,
			vcpuSecondsPerVideoMinute: perMinute === null ? null : Math.round(perMinute * 10) / 10,
		}),
	);
}
