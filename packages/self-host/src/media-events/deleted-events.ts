// `media.deleted` events of a prefix delete: one per media whose original went (a video folder is one media), none for
// what was kept, nor for a video whose outputs went while its locked original stayed.
import { createWebhookEvent, type MediaDeletedEvent, type MediaDeleteReason } from "@devultur/core";
import type { DeletedObject, RetainedObject } from "../object-lock/prefix-delete";
import { isMediaOriginal, type MediaIdentity, mediaOfKey } from "./media-key";

export interface MediaDeletedEventsOptions {
	/** Default `prefix`. */
	reason?: MediaDeleteReason;
	/** What the same call kept (`result.retained`): counted into `retainedCount` of the media they belong to. */
	retained?: RetainedObject[];
	occurredAt?: Date;
}

interface DeletedMedia {
	media: MediaIdentity;
	root: string;
	isOriginalDeleted: boolean;
}

function groupByMedia(objects: DeletedObject[]): DeletedMedia[] {
	const groups = new Map<string, DeletedMedia>();
	for (const object of objects) {
		const media = mediaOfKey(object.key);
		if (!media) continue;
		const id = `${object.root}${media.mediaKey}`;
		const group = groups.get(id) ?? { media, root: object.root, isOriginalDeleted: false };
		group.isOriginalDeleted ||= isMediaOriginal(object.key);
		groups.set(id, group);
	}
	return [...groups.values()];
}

const isUnder = (storageKey: string, mediaStorageKey: string) =>
	storageKey === mediaStorageKey || storageKey.startsWith(`${mediaStorageKey}/`);

/** One `media.deleted` per media of `objects` (from `onDeleted`) whose original was deleted. */
export function mediaDeletedEvents(
	objects: DeletedObject[],
	options: MediaDeletedEventsOptions = {},
): MediaDeletedEvent[] {
	const { reason = "prefix", retained = [], occurredAt = new Date() } = options;
	return groupByMedia(objects)
		.filter((group) => group.isOriginalDeleted)
		.map(({ media, root }) => {
			const mediaStorageKey = `${root}${media.mediaKey}`;
			const retainedCount = retained.filter((object) => isUnder(object.key, mediaStorageKey)).length;
			return createWebhookEvent(
				"media.deleted",
				{
					key: media.mediaKey,
					mediaId: media.mediaId,
					kind: media.kind,
					visibility: media.visibility,
					reason,
					...(retainedCount > 0 ? { retainedCount } : {}),
				},
				occurredAt,
			);
		});
}
