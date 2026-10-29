// `registerDevulturWebhook`: an HTTP route of your app that takes the Worker's media lifecycle webhooks, applies them
// to the component's records and then hands them to your own functions (to clean up the references your tables keep).
import { isMediaLifecycleEvent, verifyWebhookSignature, type WebhookSecret } from "@devultur/core";
import { type FunctionReference, type HttpRouter, httpActionGeneric } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import {
	type LifecycleEventArgs,
	lifecycleEventArgs,
	type MediaChangedEventArgs,
	type MediaDeletedEventArgs,
} from "./component/lifecycleValidators";

type EventHandler<Event> = FunctionReference<"mutation", "internal", { event: Event }>;

export interface DevulturWebhookOptions {
	/** Route path in your app's `convex/http.ts` (`/media-webhooks`). */
	path: string;
	/** The Worker's `MEDIA_WEBHOOK_SECRET` (several during a rotation). Default: your `DEVULTUR_WEBHOOK_SECRET`. */
	signingSecret?: WebhookSecret;
	/** Your internal mutation, run once per `media.deleted` (after the component removed its record). */
	onMediaDeleted?: EventHandler<MediaDeletedEventArgs>;
	/** Your internal mutation, run once per `media.changed` (after the component patched its record). */
	onMediaChanged?: EventHandler<MediaChangedEventArgs>;
}

const secretsFromEnv = () => (process.env.DEVULTUR_WEBHOOK_SECRET ?? "").split(/\s+/).filter(Boolean);

/**
 * Registers `POST {path}` on your HTTP router. Each signed event is applied to the component once (deduplicated by
 * id, ordered by `occurredAt`), then passed as `{ event }` to `onMediaDeleted` or `onMediaChanged`. An event counts as
 * handled only once yours returns: if it throws (or the action dies first), the route answers `500` and the Worker's
 * retry runs it again, so keep it idempotent. Order your own changes by
 * `event.occurredAt` (`isNewerEvent` from `@devultur/core`): events arrive unordered. Other event types get `204`.
 * Fails closed: without a signing secret every request gets `401`.
 */
export function registerDevulturWebhook(http: HttpRouter, component: ComponentApi, options: DevulturWebhookOptions) {
	http.route({
		path: options.path,
		method: "POST",
		handler: httpActionGeneric(async (ctx, request) => {
			const body = await request.text();
			const verification = await verifyWebhookSignature({
				payload: body,
				headers: request.headers,
				secret: options.signingSecret ?? secretsFromEnv(),
			});
			if (!verification.ok) return new Response("Unauthorized", { status: 401 });

			let payload: unknown;
			try {
				payload = JSON.parse(body);
			} catch {
				return new Response("Bad Request", { status: 400 });
			}
			if (!isMediaLifecycleEvent(payload)) return new Response(null, { status: 204 });

			const event = lifecycleEventArgs(payload);
			const handler = event.type === "media.deleted" ? options.onMediaDeleted : options.onMediaChanged;
			// With a handler, the id stays `received` until it's done: a redelivery after a failure (or a crash between
			// the two steps) runs it again, and the component's part, already applied, changes nothing the second time.
			const result = await ctx.runMutation(component.lifecycle.applyLifecycleEvent, {
				event,
				awaitsHandler: handler !== undefined,
			});
			if (result.isDuplicate || !handler) return new Response("OK", { status: 200 });
			try {
				await ctx.runMutation(handler as EventHandler<LifecycleEventArgs>, { event });
			} catch (error) {
				console.error(`[devultur] webhook handler for ${event.id} failed:`, error);
				return new Response("Handler failed", { status: 500 });
			}
			await ctx.runMutation(component.lifecycle.markLifecycleEventHandled, { eventId: event.id });
			return new Response("OK", { status: 200 });
		}),
	});
}
