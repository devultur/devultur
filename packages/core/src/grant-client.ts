// The bearer's client of a download grant: what a system that holds a grant (`dvg_…`), and no credential of the
// Worker, can do with the one file it covers. The grant travels only in `Authorization: Bearer`.
import { DevulturApiError } from "./api-error";
import { ENCRYPTED_HEADER, GRANT_EXPIRES_AT_HEADER, GRANT_KEY_HEADER, GRANT_METADATA_HEADER } from "./download-grant";
import { createWorkerTransport } from "./worker-client";
import { type DownloadLink, type DownloadLinkOptions, type FileHead, headFromResponse } from "./worker-exports";

export interface GrantFileHead extends FileHead {
	/** Whether the file is encrypted at rest. */
	encrypted: boolean;
	/** The grant's metadata, as its owner set it. */
	metadata: Record<string, string>;
	/** When the grant expires (epoch ms). */
	grantExpiresAt: number;
}

export interface GrantLinkOptions extends DownloadLinkOptions {
	/** Opaque string → string metadata (≤ 1 KB as JSON) stored with the link. */
	metadata?: Record<string, string>;
}

export interface GrantClient {
	/** The file's head, plus the grant's metadata and expiry. `null` once the grant or its file is gone. */
	head(): Promise<GrantFileHead | null>;
	/**
	 * A download link of the file. Above the grant's caps → `400 link_exceeds_grant` (nothing spent); every link
	 * already issued → `410 grant_exhausted`.
	 */
	createDownloadLink(options?: GrantLinkOptions): Promise<DownloadLink>;
	/** Deletes the file (`409 retention_active` while it's retained) and its grants. Only a grant with `canDelete`. */
	delete(): Promise<void>;
	/** Revokes the grant. Idempotent. */
	revoke(): Promise<void>;
}

function grantMetadata(response: Response): Record<string, string> {
	const header = response.headers.get(GRANT_METADATA_HEADER);
	return header ? (JSON.parse(decodeURIComponent(header)) as Record<string, string>) : {};
}

// A HEAD has no body to carry the code: on this route 410 only means the grant or its file is gone.
const isGone = (error: unknown) => error instanceof DevulturApiError && (error.status === 404 || error.status === 410);

/** Client for the file a download grant covers. `baseUrl` is the Worker's origin. */
export function createGrantClient(grant: string, baseUrl: string): GrantClient {
	const { fetchApi, request, requestVoid } = createWorkerTransport(grant, baseUrl);
	return {
		async head() {
			try {
				const response = await fetchApi("/v1/grant/file", { method: "HEAD" });
				return {
					...headFromResponse(response.headers.get(GRANT_KEY_HEADER) ?? "", response),
					encrypted: response.headers.get(ENCRYPTED_HEADER) === "true",
					metadata: grantMetadata(response),
					grantExpiresAt: Number(response.headers.get(GRANT_EXPIRES_AT_HEADER)),
				};
			} catch (error) {
				if (isGone(error)) return null;
				throw error;
			}
		},

		createDownloadLink(options = {}) {
			return request<DownloadLink>("/v1/grant/links", { method: "POST", body: JSON.stringify(options) });
		},

		delete() {
			return requestVoid("/v1/grant/file", { method: "DELETE" });
		},

		revoke() {
			return requestVoid("/v1/grant", { method: "DELETE" });
		},
	};
}
