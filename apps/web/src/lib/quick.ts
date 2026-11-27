import { parseQuickTitle } from "@tasuki/schema/pure";
import type { Member } from "./types";

/** Quick-create text → POST body. null when there is no title. An unknown @name stays in the title. */
export function buildCreate(text: string, ai: boolean, members: Member[]) {
	const p = parseQuickTitle(text);
	const who = p.assignee?.toLowerCase();
	const m = who
		? (members.find((x) => x.name.toLowerCase() === who) ??
			members.find((x) => x.name.toLowerCase().startsWith(who)))
		: undefined;
	const title = p.assignee && !m ? `${p.title} @${p.assignee}`.trim() : p.title;
	if (!title) return null;
	return {
		title,
		flow: ai ? ("ai" as const) : ("simple" as const),
		labels: p.labels,
		...(p.priority !== undefined && { priority: p.priority }),
		...(m && { assigneeId: m.id }),
	};
}
