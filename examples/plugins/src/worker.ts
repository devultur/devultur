// A media Worker built from the example plugins: rate limiting, JWT auth from your identity provider, a usage log in
// D1, plus the default config, credential policy and download links.
import { createWorker, credentialPolicy, downloadLinks, staticConfig } from "@devultur/self-host";
import { jwtAuth } from "./jwt-auth";
import { rateLimit } from "./rate-limit";
import { d1Sink, usageLog } from "./usage-log";

export { DownloadLink } from "@devultur/self-host";

export default createWorker({
	plugins: [
		rateLimit({ binding: "RATE_LIMITER" }),
		staticConfig({
			uploadRules: { image: { maxSizeBytes: 10_000_000, accept: ["image/*"] } },
			transcode: { maxResolution: "1080p" },
		}),
		jwtAuth({
			jwksUri: "https://auth.example.com/.well-known/jwks.json",
			issuer: "https://auth.example.com/",
			audience: "media",
			// One folder of the bucket per app of yours; a token without an `app` claim is refused.
			storagePrefix: (claims) => (typeof claims.app === "string" ? `${claims.app}/` : null),
		}),
		credentialPolicy({ maxTtlSeconds: { viewer: 2 * 60 * 60 } }),
		downloadLinks(),
		usageLog({ sink: d1Sink("USAGE_DB") }),
	],
});
