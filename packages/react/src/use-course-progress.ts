"use client";

import React from "react";
import { useProgressContext } from "./context";

interface UseCourseProgressReturn {
	percent: number;
	completedCount: number;
	totalCount: number;
	isComplete: boolean;
}

/**
 * Aggregates completion progress across a course's lessons into a single percentage.
 */
export function useCourseProgress(_courseId: string, lessonIds: string[]): UseCourseProgressReturn {
	const { load } = useProgressContext();
	const [completedCount, setCompletedCount] = React.useState(0);
	const totalCount = lessonIds.length;

	React.useEffect(() => {
		let cancelled = false;

		Promise.all(lessonIds.map((id) => load(id)))
			.then((results) => {
				if (cancelled) return;
				const completed = results.filter((r) => r?.completedAt !== null && r?.completedAt !== undefined).length;
				setCompletedCount(completed);
			})
			.catch(() => {
				if (!cancelled) setCompletedCount(0);
			});

		return () => {
			cancelled = true;
		};
	}, [lessonIds, load]);

	const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
	const isComplete = totalCount > 0 && completedCount === totalCount;

	return { percent, completedCount, totalCount, isComplete };
}
