// rate-limit: answer 429 to a client that sends too many requests, with Cloudflare's Rate Limiting binding. It runs
// before authentication, so a flood never reaches token verification or R2.
//
//   # wrangler.toml
//   [[ratelimits]]
//   name = "RATE_LIMITER"
//   namespace_id = "1001"
//   simple = { limit = 100, period = 60 }
//
//   createWorker({ plugins: [rateLimit({ binding: "RATE_LIMITER" }), ...defaultPlugins(config)] })
import type { WorkerPlugin } from "@devultur/self-host";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

/** What the Rate Limiting binding exposes. */
interface RateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitOptions {
	/** Name of the `[[ratelimits]]` binding. */
	binding: string;
	/** Who is limited: by default the client IP. A plugin after auth could key by user instead. */
	key?: (context: Context) => string;
	/** Requests it applies to. Default: everything but CORS preflights and `/health`. */
	applies?: (context: Context) => boolean;
	/** Seconds the client is told to wait (`Retry-After`): the binding's `period`. */
	retryAfterSeconds?: number;
}

const clientIp = (context: Context) => context.req.header("CF-Connecting-IP") ?? "unknown";
const isLimited = (context: Context) => context.req.method !== "OPTIONS" && context.req.path !== "/health";

export function rateLimit(options: RateLimitOptions): WorkerPlugin {
	const limit = createMiddleware(async (context, next) => {
		if (!(options.applies ?? isLimited)(context)) return next();
		const limiter = (context.env as Record<string, RateLimiter | undefined>)[options.binding];
		// No binding (local dev without it): don't limit rather than fail every request.
		if (!limiter) return next();
		const { success } = await limiter.limit({ key: (options.key ?? clientIp)(context) });
		if (success) return next();
		const retryAfter = String(options.retryAfterSeconds ?? 60);
		return context.json({ error: "Too many requests", code: "rate_limited" }, 429, { "Retry-After": retryAfter });
	});
	return { name: "rate-limit", middleware: { beforeAuth: [limit] } };
}
