// `downloadLinks()`: single-use download links. `POST /v1/token/download` creates one in the `DownloadLink` Durable
// Object (binding `DOWNLOAD_LINKS`) and `GET /v1/download/{id}` redeems it. Plugins with `beforeLinkRedeem` can refuse a
// redemption before its use is spent. Also download grants: `/v1/token/grant` (the owner issues, lists and revokes
// them) and `/v1/grant` (the bearer), in the `DownloadGrants` Durable Object (binding `DOWNLOAD_GRANTS`). Without
// this plugin those paths answer 404.
import { Hono } from "hono";
import type { WorkerPlugin } from "../plugin";
import { download, handleDownloadLink } from "../routes/download";
import { grantBearer } from "../routes/grant-bearer";
import { grantOwner } from "../routes/grant-owner";
import type { WorkerApp } from "../types";

export function downloadLinks(): WorkerPlugin {
	const issue = new Hono<WorkerApp>().post("/", handleDownloadLink);
	return {
		name: "download-links",
		routes: [
			{ path: "/v1/token/download", app: issue },
			{ path: "/v1/download", app: download },
			{ path: "/v1/token/grant", app: grantOwner },
			{ path: "/v1/grant", app: grantBearer },
		],
	};
}
