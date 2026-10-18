import type { WorkerPlugin } from "../plugin";
import type { WorkerConfig } from "../request-state";
import { credentialPolicy } from "./credential-policy";
import { downloadLinks } from "./download-links";
import { staticConfig } from "./static-config";
import { workerSecretAuth } from "./worker-secret-auth";

export { type CredentialPolicyOptions, credentialPolicy } from "./credential-policy";
export { downloadLinks } from "./download-links";
export { staticConfig } from "./static-config";
export { isOpenRoute, isUploadUrl, WorkerAuthErrorCode, workerSecretAuth } from "./worker-secret-auth";

/**
 * The plugins `createWorker()` uses when given none: `config` for every request, the worker-secret auth, the default
 * credential policy and download links. Spread them to add your own, or keep only the ones you want.
 */
export function defaultPlugins(config: WorkerConfig = {}): WorkerPlugin[] {
	return [staticConfig(config), workerSecretAuth(), credentialPolicy(), downloadLinks()];
}
