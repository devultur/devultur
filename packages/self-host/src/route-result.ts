// Route result: what a route did that the request alone does not say, for plugin middleware that runs after
// `await next()` (usage logs, cache purges, notifications). Set by the routes, read with `getRouteResult`.
import type { Context } from "hono";
import type { PluginContext } from "./request-state";

/** A download link as the Worker hands it to plugins. */
export interface DownloadLinkInfo {
	/** Storage prefix the link was issued under. */
	storagePrefix: string;
	/** Key of the file (`{visibility}/…`), relative to the storage prefix. */
	key: string;
	/** Plugin context of the request that issued the link, as it was stored. */
	context?: PluginContext;
}

/** The transcode job a runner callback belongs to (from the job ticket the Worker signed at launch). */
export interface TranscodeJob {
	/** Unique per launch: a re-encode of the same video is another run. */
	runId: string;
	videoId: string;
	/** Launch time (epoch ms, second precision). */
	startedAt: number;
	/** Plugin context of the request that launched the job, as it was. */
	context?: PluginContext;
}

export interface RouteResult {
	/** `GET /v1/download/{id}` redeemed this link (one use spent). */
	redeemedLink?: DownloadLinkInfo;
	/** `transcode.complete` deleted the video's original (`config.transcode.deleteOriginalOnSuccess`). */
	originalDeleted?: boolean;
	/** The transcode callback carried a valid job ticket: the job it belongs to. */
	transcodeJob?: TranscodeJob;
}

/** Context variable that holds the result. Internal. */
export const ROUTE_RESULT_VARIABLE = "routeResult";

// biome-ignore lint/suspicious/noExplicitAny: any app that mounts the Worker (its own bindings and variables)
type AnyContext = Context<any>;

export function getRouteResult(context: AnyContext): RouteResult {
	return (context.get(ROUTE_RESULT_VARIABLE) as RouteResult | undefined) ?? {};
}

export function addRouteResult(context: AnyContext, result: RouteResult): void {
	context.set(ROUTE_RESULT_VARIABLE, { ...getRouteResult(context), ...result });
}
