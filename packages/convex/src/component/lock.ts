// Object lock from the app's server: read and change an object's retention, and set or release holds on a list of
// keys. These are component functions, so only the app's own functions can call them (never a browser). A bulk hold
// by prefix stays on the app's server, with `@devultur/core`'s `createWorkerClient(...).lock.holdAll({ prefix })`.
// A refusal throws a `ConvexError` whose `data.code` is the Worker's (`retention_active`, `compliance_extend_only`,
// `lock_privilege_required`, `lock_conflict`, ...); see workerErrors.ts.
import { HOLD_PAGE_SIZE } from "@devultur/core";
import { v } from "convex/values";
import { derivativesValidator, retentionModeValidator } from "./lockValidators";
import { getMediaClient } from "./mediaClient";
import { workerAction } from "./workerErrors";

const keysValidator = v.array(v.string());

export const getLock = workerAction({
	args: { key: v.string() },
	handler: async (_ctx, args) => getMediaClient().lock.get(args.key),
});

export const setLock = workerAction({
	args: {
		key: v.string(),
		mode: v.optional(retentionModeValidator),
		until: v.optional(v.string()),
		period: v.optional(v.number()),
		derivatives: v.optional(derivativesValidator),
		remove: v.optional(v.literal(true)),
		bypassGovernance: v.optional(v.boolean()),
	},
	handler: async (_ctx, { key, ...options }) => getMediaClient().lock.set(key, options),
});

/** Holds every key, a page of {@link HOLD_PAGE_SIZE} at a time; returns what changed and what didn't. */
async function changeHolds(keys: string[], hold: boolean) {
	const lock = getMediaClient().lock;
	const updated: string[] = [];
	const skipped: { key: string; reason: string }[] = [];
	for await (const page of hold ? lock.holdAll(keys) : lock.releaseAll(keys)) {
		updated.push(...page.updated);
		skipped.push(...page.skipped);
	}
	return { updated, skipped, pageSize: HOLD_PAGE_SIZE };
}

export const setHold = workerAction({
	args: { keys: keysValidator },
	handler: async (_ctx, args) => changeHolds(args.keys, true),
});

export const releaseHold = workerAction({
	args: { keys: keysValidator },
	handler: async (_ctx, args) => changeHolds(args.keys, false),
});
