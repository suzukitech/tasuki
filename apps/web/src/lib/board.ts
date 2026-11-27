import { generateKeyBetween } from "fractional-indexing";
import { t } from "../i18n";
import { ApiError } from "./api";
import type { IssueRow, Status } from "./types";

/** Droppable id of a column's empty area. Cards use their issue id. */
export const colId = (statusId: string) => `col:${statusId}`;

/** Rank keys are fractional-indexing strings: they order by plain code-unit comparison. */
const byRank = (a: IssueRow, b: IssueRow) =>
	a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.number - b.number;

/** statusId → its issues in rank order. Every status has an entry, even an empty one. */
export function columnsOf(
	statuses: Status[],
	rows: IssueRow[],
): Map<string, IssueRow[]> {
	const cols = new Map(
		[...statuses]
			.sort((a, b) => a.position - b.position)
			.map((s) => [s.id, [] as IssueRow[]]),
	);
	for (const r of rows) cols.get(r.statusId)?.push(r);
	for (const list of cols.values()) list.sort(byRank);
	return cols;
}

/**
 * Where a dropped card lands. `overId` is a card id or a column id.
 * Returns null when nothing changes. `rank` is omitted (server appends) if the
 * neighbours cannot take a key between them.
 */
export function planDrop(
	cols: Map<string, IssueRow[]>,
	activeId: string,
	overId: string,
): { statusId: string; rank?: string } | null {
	if (activeId === overId) return null;
	let from: string | undefined;
	let target: string | undefined;
	let at = -1; // insertion index in the target column without the moved card
	for (const [sid, list] of cols) {
		if (list.some((i) => i.id === activeId)) from = sid;
		if (colId(sid) === overId) target = sid;
		else if (list.some((i) => i.id === overId)) target = sid;
	}
	if (!from || !target) return null;
	const rest = (cols.get(target) ?? []).filter((i) => i.id !== activeId);
	const oldIndex = (cols.get(from) ?? []).findIndex((i) => i.id === activeId);
	if (colId(target) === overId) at = rest.length;
	else {
		const over = (cols.get(target) ?? []).findIndex((i) => i.id === overId);
		// dragging down inside a column drops after the card under the pointer (arrayMove semantics)
		at =
			from === target && over > oldIndex
				? over
				: rest.findIndex((i) => i.id === overId);
	}
	if (from === target && at === oldIndex) return null;
	const prev = rest[at - 1]?.rank ?? null;
	const next = rest[at]?.rank ?? null;
	try {
		return { statusId: target, rank: generateKeyBetween(prev, next) };
	} catch {
		return { statusId: target };
	}
}

/** Toast text for a refused move: say what happened, then the server's own words. */
export function moveError(e: unknown): string {
	return e instanceof ApiError
		? `${t("board.move.fail")}${e.message}`
		: t("toast.network");
}
