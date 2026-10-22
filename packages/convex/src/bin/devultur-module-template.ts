// The `convex/devultur.ts` that `devultur-init` writes: the exposed functions behind a sign-in guard.
export const DEVULTUR_MODULE_TEMPLATE = `import { CaptionLocale, Devultur, defineDevulturFunctions, TranscodePreset } from "@devultur/convex";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";

const devultur = new Devultur(components.devultur);

// Every function below runs this guard first. Adjust it to your app's auth and rules (narrow on \`operation.name\`).
export const {
	issueViewerToken,
	createUploadUrl,
	confirmUpload,
	deleteMedia,
	deleteVideo,
	processVideo,
	getMedia,
	// The library lists and searches every user's media: the guard decides who may read it.
	listMediaPage,
	searchMedia,
	// Editing a title, alt text or tags is library-wide too: authorize it in the guard before exporting it.
	// updateMediaMeta,
	saveProgress,
	loadProgress,
	markComplete,
	resetProgress,
} = defineDevulturFunctions(devultur, {
	guard: async (ctx, operation) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new ConvexError(\`Sign in to call \${operation.name}\`);
		// The progress functions act only for this user: another \`userId\` in their arguments is refused.
		return { userId: identity.subject };
	},
	config: {
		video: {
			transcodePreset: TranscodePreset.HLS_720P,
			captionLocales: [CaptionLocale.EN],
		},
	},
});
`;
