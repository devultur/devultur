import { defineComponent } from "convex/server";
import { v } from "convex/values";

const component = defineComponent("devultur", {
	env: {
		DEVULTUR_SECRET: v.string(),
		DEVULTUR_API_URL: v.string(),
		// Signing secret of the Worker's media webhooks (`MEDIA_WEBHOOK_SECRET`), several space-separated during a
		// rotation. Unset: `/webhook` accepts only the bearer.
		DEVULTUR_WEBHOOK_SECRET: v.optional(v.string()),
	},
});

export default component;
