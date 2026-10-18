import { defineComponent } from "convex/server";
import { v } from "convex/values";

const component = defineComponent("devultur", {
	env: {
		DEVULTUR_SECRET: v.string(),
		DEVULTUR_API_URL: v.string(),
	},
});

export default component;
