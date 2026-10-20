// Job ticket: a token the Worker signs when it launches a transcode and the runner echoes on every callback (header
// `X-Devultur-Job`). It names the job the callback belongs to: the video, a run id unique per launch, the launch time
// and the plugin context of the request that launched it. The shared callback secret only proves "a runner of this
// Worker"; the ticket proves "this job", so a layer mounted on the Worker can act on the callback without keeping
// anything per job.
//
// Signed with a key derived from `DELIVERY_SIGN_SECRET` (domain-separated): a ticket is never a valid viewer token, and
// the runner (it holds the callback secret, not the signing key) can neither forge nor alter one.
import { generateId } from "@devultur/core";
import { signViewerToken, verifyViewerToken } from "../helpers";
import type { PluginContext } from "../request-state";
import type { TranscodeJob } from "../route-result";

export const JOB_TICKET_HEADER = "X-Devultur-Job";
const JOB_TICKET_TYPE = "transcode-job";
const JOB_TICKET_KEY_SUFFIX = ":transcode-job-ticket";
// The job lives up to a day and its completion callback is retried after that.
const JOB_TICKET_TTL_SECONDS = 2 * 24 * 60 * 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const ticketKey = (secret: string) => `${secret}${JOB_TICKET_KEY_SUFFIX}`;

/** Where the job's video lives: its storage prefix and virtual folder (`{visibility}/video/{id}`). */
export interface JobLocation {
	root: string;
	folder: string;
}

/** Signs the ticket of a new run of `videoId`. */
export async function signJobTicket(
	secret: string,
	job: { videoId: string; context?: PluginContext; location?: JobLocation },
	nowMs = Date.now(),
): Promise<{ ticket: string; runId: string }> {
	const runId = generateId();
	const issuedAt = Math.floor(nowMs / 1000);
	const ticket = await signViewerToken(
		{
			typ: JOB_TICKET_TYPE,
			sub: job.videoId,
			jti: runId,
			iat: issuedAt,
			exp: issuedAt + JOB_TICKET_TTL_SECONDS,
			...(job.context ? { context: job.context } : {}),
			...(job.location ? { loc: { root: job.location.root, folder: job.location.folder } } : {}),
		},
		ticketKey(secret),
	);
	return { ticket, runId };
}

/** The job of a callback for `videoId`, or null when the ticket is missing, forged, expired or for another video. */
export async function verifyJobTicket(
	secret: string,
	ticket: string | undefined,
	videoId: string,
): Promise<TranscodeJob | null> {
	const claims = await verifyViewerToken(ticket, ticketKey(secret));
	if (claims?.typ !== JOB_TICKET_TYPE || claims.sub !== videoId) return null;
	if (typeof claims.jti !== "string" || typeof claims.iat !== "number") return null;
	return {
		runId: claims.jti,
		videoId,
		startedAt: claims.iat * 1000,
		...(isRecord(claims.context) ? { context: claims.context as PluginContext } : {}),
	};
}

/**
 * The video's location a verified ticket carries (signed at launch, so a runner can't point it at another video), or
 * null. It outlives the launch's KV records: the ticket lives as long as the job's callbacks.
 */
export async function verifyJobLocation(
	secret: string,
	ticket: string | undefined,
	videoId: string,
): Promise<JobLocation | null> {
	const claims = await verifyViewerToken(ticket, ticketKey(secret));
	if (claims?.typ !== JOB_TICKET_TYPE || claims.sub !== videoId || !isRecord(claims.loc)) return null;
	const { root, folder } = claims.loc;
	return typeof root === "string" && typeof folder === "string" ? { root, folder } : null;
}
