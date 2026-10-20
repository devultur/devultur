// Test support for the bucket-level lock helpers: a media and a keys bucket in memory on one clock (R2 compares a key
// and the object it encrypts by when each was written), and shorthands to store objects, keys and lock records.
import type { ObjectLock } from "@devultur/core";
import { memoryBucket } from "../exports-test-harness";
import { sidecarKey, writeSidecar } from "./sidecar";

export const ROOT = "apps/a1/";
export const FAR_FUTURE = "2999-01-01T00:00:00Z";

export const compliance: ObjectLock = { retention: { mode: "compliance", until: FAR_FUTURE }, hold: false };
export const governance: ObjectLock = { retention: { mode: "governance", until: FAR_FUTURE }, hold: false };
export const expired: ObjectLock = { retention: { mode: "compliance", until: "2000-01-01T00:00:00Z" }, hold: false };

export function lockBuckets() {
	let writes = 0;
	const now = () => new Date(++writes);
	const media = memoryBucket({ now });
	const keys = memoryBucket({ now });
	const mediaBucket = media as unknown as R2Bucket;
	const keysBucket = keys as unknown as R2Bucket;

	/** An object at `root + key`, its encryption key first (written before it, like the Worker does). */
	const putObject = async (key: string, options: { lock?: ObjectLock; size?: number; root?: string } = {}) => {
		const storageKey = `${options.root ?? ROOT}${key}`;
		await keys.put(`${storageKey}/k1`, "key");
		const customMetadata: Record<string, string> = options.lock ? { lock: JSON.stringify(options.lock) } : {};
		await media.put(storageKey, new Uint8Array(options.size ?? 10), { customMetadata });
		return storageKey;
	};

	/** A lock change through the API: a sidecar bound to the object's current version. */
	const setSidecar = async (key: string, lock: ObjectLock, root = ROOT) => {
		const object = await media.head(`${root}${key}`);
		const objectVersion = object?.version ?? "";
		const sidecar = { revision: 1, objectVersion, lock, updatedAt: new Date(0).toISOString() };
		await writeSidecar(mediaBucket, root, key, sidecar, null);
	};

	const corruptSidecar = (key: string, root = ROOT) => media.put(sidecarKey(root, key), "{not json");

	/** Every call made on either bucket. */
	let calls = 0;
	const counted = (bucket: R2Bucket) =>
		new Proxy(bucket, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					calls += 1;
					return value.apply(target, args);
				};
			},
		});
	const countedBuckets = () => ({ mediaBucket: counted(mediaBucket), keysBucket: counted(keysBucket) });
	const callCount = () => calls;
	const resetCalls = () => {
		calls = 0;
	};

	const hasMedia = (key: string, root = ROOT) => media.objects.has(`${root}${key}`);
	const hasKey = (key: string, root = ROOT) => keys.objects.has(`${root}${key}`);
	return {
		media,
		keys,
		mediaBucket,
		keysBucket,
		putObject,
		setSidecar,
		corruptSidecar,
		countedBuckets,
		callCount,
		resetCalls,
		hasMedia,
		hasKey,
	};
}
