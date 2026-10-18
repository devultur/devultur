// `downloadLinks()`: single-use download links. `POST /v1/token/download` creates one in the `DownloadLink` Durable
// Object (binding `DOWNLOAD_LINKS`) and `GET /v1/download/{id}` redeems it. Plugins with `beforeLinkRedeem` can refuse a
// redemption before its use is spent. Without this plugin both paths answer 404.
import { Hono } from "hono";
import type { WorkerPlugin } from "../plugin";
import { download, handleDownloadLink } from "../routes/download";
import type { WorkerApp } from "../types";

export function downloadLinks(): WorkerPlugin {
	const issue = new Hono<WorkerApp>().post("/", handleDownloadLink);
	return {
		name: "download-links",
		routes: [
			{ path: "/v1/token/download", app: issue },
			{ path: "/v1/download", app: download },
		],
	};
}
