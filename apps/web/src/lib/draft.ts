import type { Criterion } from "./types";

/** An edited field shows the draft; an untouched one (undefined) follows the server value. */
export const shown = <T>(draft: T | undefined, server: T): T =>
	draft === undefined ? server : draft;

export type CritDraft = { id: string | undefined; text: string };
export const critsOf = (
	criteria: Pick<Criterion, "id" | "text">[],
): CritDraft[] => criteria.map((c) => ({ id: c.id, text: c.text }));

/** PUT /criteria body: blanks dropped, known rows keep their id (so their results survive). */
export const criteriaBody = (crit: CritDraft[]) =>
	crit
		.filter((c) => c.text.trim())
		.map((c) =>
			c.id ? { id: c.id, text: c.text.trim() } : { text: c.text.trim() },
		);
