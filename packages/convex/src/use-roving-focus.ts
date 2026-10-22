"use client";

import React from "react";

/**
 * The index a key moves to in a grid of `count` items laid out in `columns` columns, or `null` for any other key.
 * Arrows stop at the edges; Home and End go to the first and last item.
 */
export function nextIndex(key: string, current: number, count: number, columns: number): number | null {
	const last = count - 1;
	const clamp = (index: number) => Math.min(Math.max(index, 0), last);
	switch (key) {
		case "ArrowRight":
			return clamp(current + 1);
		case "ArrowLeft":
			return clamp(current - 1);
		case "ArrowDown":
			return current + columns > last ? current : current + columns;
		case "ArrowUp":
			return current - columns < 0 ? current : current - columns;
		case "Home":
			return 0;
		case "End":
			return last;
		default:
			return null;
	}
}

/** How many items share the first row, from their layout; 1 when nothing is laid out (no CSS, a test). */
function columnCount(items: Array<HTMLElement | null>): number {
	const firstTop = items[0]?.getBoundingClientRect();
	if (!firstTop || firstTop.height === 0) return 1;
	const inFirstRow = items.filter((item) => item?.getBoundingClientRect().top === firstTop.top);
	return Math.max(inFirstRow.length, 1);
}

/**
 * Roving tabindex over `count` items: one of them is in the tab order (`tabIndex(index)`), and the arrow keys, Home
 * and End move it and the focus. Attach `itemRef(index)` to each item and `handleKeyDown` to their container.
 */
export function useRovingFocus(count: number) {
	const [activeIndex, setActiveIndex] = React.useState(0);
	const itemsRef = React.useRef<Array<HTMLElement | null>>([]);
	// Derived: a shorter list (a new search) moves the active item back into range.
	const currentIndex = Math.min(activeIndex, Math.max(count - 1, 0));

	const itemRef = React.useCallback(
		(index: number) => (element: HTMLElement | null) => {
			itemsRef.current[index] = element;
		},
		[],
	);

	const handleKeyDown = React.useCallback(
		(event: React.KeyboardEvent) => {
			if (count === 0) return;
			const items = itemsRef.current.slice(0, count);
			const target = nextIndex(event.key, currentIndex, count, columnCount(items));
			if (target === null) return;
			event.preventDefault();
			setActiveIndex(target);
			items[target]?.focus();
		},
		[count, currentIndex],
	);

	const tabIndex = (index: number) => (index === currentIndex ? 0 : -1);

	return { activeIndex: currentIndex, setActiveIndex, itemRef, handleKeyDown, tabIndex };
}
