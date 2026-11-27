import { generateKeyBetween } from "fractional-indexing";
import type { IssueRow, Status } from "./types";

/** Droppable id of a column's empty area. Cards use their issue id. */
export const colId = (statusId: string) => `col:${statusId}`;

/** Rank keys are fractional-indexing strings: they order by plain code-unit comparison. */
const byRank = (a: IssueRow, b: IssueRow) =>
	a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.number - b.number;

export type Cols = [Status, IssueRow[]][];

/** Status columns in `position` order, each with its issues in rank order. Empty columns are kept. */
export function columnsOf(statuses: Status[], rows: IssueRow[]): Cols {
	const cols: Cols = [...statuses]
		.sort((a, b) => a.position - b.position)
		.map((s) => [s, []]);
	const by = new Map(cols.map(([s, l]) => [s.id, l]));
	for (const r of rows) by.get(r.statusId)?.push(r);
	for (const [, list] of cols) list.sort(byRank);
	return cols;
}

/** The column an over-target belongs to: `overId` is a card id or a column id. */
export const colOfOver = (cols: Cols, overId: unknown) =>
	cols.find(
		([s, l]) => colId(s.id) === overId || l.some((i) => i.id === overId),
	);

/**
 * Where a dropped card lands. `overId` is a card id or a column id.
 * Returns null when nothing changes. `rank` is omitted (server appends) if the
 * neighbours cannot take a key between them; `appended` then says so.
 */
export function planDrop(
	cols: Cols,
	activeId: string,
	overId: string,
): { statusId: string; rank?: string; appended?: true } | null {
	if (activeId === overId) return null;
	const from = cols.find(([, l]) => l.some((i) => i.id === activeId));
	const to = colOfOver(cols, overId);
	if (!from || !to) return null;
	const target = to[0].id;
	const rest = to[1].filter((i) => i.id !== activeId);
	const oldIndex = from[1].findIndex((i) => i.id === activeId);
	let at: number; // insertion index in the target column without the moved card
	if (colId(target) === overId) at = rest.length;
	else {
		const over = to[1].findIndex((i) => i.id === overId);
		// dragging down inside a column drops after the card under the pointer (arrayMove semantics)
		at =
			from[0].id === target && over > oldIndex
				? over
				: rest.findIndex((i) => i.id === overId);
	}
	if (from[0].id === target && at === oldIndex) return null;
	const prev = rest[at - 1]?.rank ?? null;
	const next = rest[at]?.rank ?? null;
	try {
		return { statusId: target, rank: generateKeyBetween(prev, next) };
	} catch {
		return { statusId: target, appended: true };
	}
}
