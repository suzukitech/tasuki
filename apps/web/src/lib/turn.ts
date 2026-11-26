import { whoseTurn } from "@tasuki/schema";
import type { Key } from "../i18n";
import type { IssueRow, Status } from "./types";

export type Turn = NonNullable<ReturnType<typeof whoseTurn>>;
export const TURN_KEY: Record<Turn, Key> = {
	you: "turn.you",
	ai: "turn.ai",
	others: "turn.others",
};

/** Badge for a list row. null when nobody's turn (done) or the status is unknown. */
export function turnOf(
	issue: IssueRow,
	statuses: Status[],
	userId: string,
): Turn | null {
	const category = statuses.find((s) => s.id === issue.statusId)?.category;
	if (!category) return null;
	return whoseTurn({ ...issue, category }, userId);
}
