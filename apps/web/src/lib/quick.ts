import { parseQuickTitle } from "@tasuki/schema/pure";
import type { Member } from "./types";

/** Exact (case-insensitive) name first, then a prefix match. */
const matchMember = (who: string | undefined, members: Member[]) => {
	const w = who?.toLowerCase();
	return w
		? (members.find((x) => x.name.toLowerCase() === w) ??
				members.find((x) => x.name.toLowerCase().startsWith(w)))
		: undefined;
};

/** Quick-create text → POST body. null when there is no title. An unknown @name stays in the title. */
export function buildCreate(text: string, ai: boolean, members: Member[]) {
	const p = parseQuickTitle(text);
	const m = matchMember(p.assignee, members);
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

/** What Enter would set, for the live chips under the quick-create bar. */
export function previewQuick(text: string, members: Member[]) {
	const p = parseQuickTitle(text);
	return {
		assignee: matchMember(p.assignee, members),
		labels: p.labels,
		priority: p.priority,
	};
}
