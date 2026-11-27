import type { InfiniteData } from "@tanstack/react-query";
import type { Page } from "./types";

export type Patch = {
	statusId?: string;
	rank?: string;
	assigneeId?: string | null;
	priority?: number | null;
};

/**
 * Apply an optimistic patch to a cached infinite list. Anything that is not infinite data
 * (a plain Page, undefined) comes back untouched, so a broad `setQueriesData` can never corrupt it.
 */
export function mapPages<T>(d: T, ref: string, patch: Patch): T {
	const inf = d as InfiniteData<Page> | undefined;
	if (!inf || !Array.isArray(inf.pages)) return d;
	return {
		...inf,
		pages: inf.pages.map((p) => ({
			...p,
			items: p.items.map((i) => (i.ref === ref ? { ...i, ...patch } : i)),
		})),
	} as T;
}

/** "WEB-12" → "WEB" */
export const projectOf = (ref: string) => ref.slice(0, ref.lastIndexOf("-"));
