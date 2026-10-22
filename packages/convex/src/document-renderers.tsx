"use client";

import React from "react";
import type { DevulturMedia } from "@devultur/core";
import { AttachmentIcon } from "./attachment-icons";
import {
	type AttachmentLabels,
	attachmentDetails,
	attachmentKindOf,
	attachmentName,
	mergeAttachmentLabels,
} from "./attachment-labels";
import { DownloadLink, useDevultur } from "./react";

export interface DocumentLinkProps
	extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "download" | "media"> {
	/** Typed reference. `null`/`undefined` → renders nothing. */
	media: DevulturMedia | null | undefined;
	/** `true` → the link downloads the file instead of opening it. Private media always downloads. Default `false`. */
	download?: boolean;
	/** Text of the link. Default: the media's `title`, else its filename, else `labels.untitled`. */
	children?: React.ReactNode;
	labels?: Partial<AttachmentLabels>;
}

/**
 * A link to a media's file, named after it. Public: a plain link to the delivery URL (it opens in the browser, or
 * downloads with `download`). Private: a navigation can't send the session header, so the click fetches the file
 * with it and downloads it, as `<DownloadLink>` does.
 *
 * @example
 * <DocumentLink media={invoice.file} target="_blank" rel="noopener" />
 */
export function DocumentLink({ media, download = false, children, labels, ...anchorProps }: DocumentLinkProps) {
	const { url } = useDevultur();
	if (!media) return null;
	const text = children ?? attachmentName(media, mergeAttachmentLabels(labels).untitled);
	if (download || media.visibility === "private") {
		return (
			<DownloadLink media={media} {...anchorProps}>
				{text}
			</DownloadLink>
		);
	}
	return (
		<a href={url(media)} {...anchorProps}>
			{text}
		</a>
	);
}

type HeadingLevel = 2 | 3 | 4 | 5 | 6;

export interface AttachmentCardProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
	/** Typed reference. `null`/`undefined` → renders nothing. */
	media: DevulturMedia | null | undefined;
	/** The type you know the media has. Default: inferred from `media.filename`'s extension (picks the icon). */
	contentType?: string;
	/** Shows an "Open preview" button that calls this, e.g. to render `<Preview>` in a dialog. */
	onOpen?: (media: DevulturMedia) => void;
	/** Shown in place of the type icon, e.g. a `<PdfThumbnail>` or an `<Image>`. */
	preview?: React.ReactNode;
	/** Level of the name's heading. Default `3`. */
	headingLevel?: HeadingLevel;
	/** Locale for the size. Default: `labels.locale` (`en`). */
	locale?: string;
	labels?: Partial<AttachmentLabels>;
}

/**
 * A card for an attachment: an icon by type (or your `preview`), its name, its type and size, its page count (PDF)
 * or duration (audio, video), a download link and, with `onOpen`, an "Open preview" button. Unstyled: target its
 * parts with `data-part` (`icon`, `name`, `details`, `actions`, `download`, `open`).
 *
 * @example
 * <AttachmentCard media={file} onOpen={setPreviewed} />
 */
export function AttachmentCard({
	media,
	contentType,
	onOpen,
	preview,
	headingLevel = 3,
	locale,
	labels,
	...articleProps
}: AttachmentCardProps) {
	const headingId = React.useId();
	if (!media) return null;
	const text = mergeAttachmentLabels(labels);
	const kind = attachmentKindOf(media, contentType);
	const details = attachmentDetails(media, kind, text, locale ?? text.locale);
	const Heading = `h${headingLevel}` as const;

	return (
		<article aria-labelledby={headingId} data-kind={kind} {...articleProps}>
			{preview ?? <AttachmentIcon kind={kind} />}
			<Heading id={headingId} data-part="name">
				{attachmentName(media, text.untitled)}
			</Heading>
			<p data-part="details">{details.join(" · ")}</p>
			<div data-part="actions">
				<DownloadLink media={media} aria-describedby={headingId} data-part="download">
					{text.download}
				</DownloadLink>
				{onOpen && (
					<button type="button" onClick={() => onOpen(media)} aria-describedby={headingId} data-part="open">
						{text.open}
					</button>
				)}
			</div>
		</article>
	);
}
