import { isBearerOf } from "@devultur/core";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
	path: "/webhook",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		// Fails closed: with `DEVULTUR_SECRET` unset or empty no request is authorized.
		if (!isBearerOf(request.headers.get("Authorization"), env.DEVULTUR_SECRET)) {
			return new Response("Unauthorized", { status: 401 });
		}

		try {
			const event = await request.json();
			await ctx.runMutation(internal.public.handleWebhookEvent, event);
			return new Response("OK", { status: 200 });
		} catch {
			return new Response("Bad Request", { status: 400 });
		}
	}),
});

export default http;
