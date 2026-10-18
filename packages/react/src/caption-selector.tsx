"use client";

import React from "react";
import type { CaptionSelectorProps } from "./types";

/**
 * Select dropdown for choosing the active caption locale or turning captions off.
 */
export function CaptionSelector({
	captions,
	activeLocale,
	onSelect,
	includeOff = true,
	className,
}: CaptionSelectorProps): React.ReactElement {
	const handleChange = React.useCallback(
		(event: React.ChangeEvent<HTMLSelectElement>) => {
			const value = event.target.value;
			onSelect(value === "" ? null : value);
		},
		[onSelect],
	);

	return (
		<select
			className={className}
			value={activeLocale ?? ""}
			onChange={handleChange}
			data-caption-selector=""
			aria-label="Caption language"
		>
			{includeOff && <option value="">Off</option>}
			{captions.map((caption) => (
				<option key={caption.locale} value={caption.locale}>
					{caption.label}
				</option>
			))}
		</select>
	);
}
