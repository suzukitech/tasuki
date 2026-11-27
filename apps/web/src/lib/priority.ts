import { PRIORITIES } from "@tasuki/schema/pure";
import type { Key } from "../i18n";

/** i18n keys of the priority levels, ordered by value (index = priority number). */
export const PRIORITY_KEYS = Object.keys(PRIORITIES).map(
	(k) => `priority.${k}` as Key,
);
