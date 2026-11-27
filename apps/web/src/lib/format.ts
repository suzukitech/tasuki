/** Display helpers for the list and panel. Pure so they can be tested. */
import { type Key, t } from "../i18n";
import { ja } from "../i18n/ja";
import { PRIORITY_KEYS } from "./priority";
import type { Activity, Member, Status } from "./types";

const DAY = 86_400_000;
const ymd = (d: Date) =>
	Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;

const dateFmt = new Intl.DateTimeFormat("ja-JP", {
	year: "numeric",
	month: "long",
	day: "numeric",
	weekday: "short",
});
const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

/** Whole days from today (local) to a YYYY-MM-DD due date; negative = overdue. */
function daysUntil(due: string, now: Date): number {
	const [y = 0, m = 1, d = 1] = due.split("-").map(Number);
	return Math.round(Date.UTC(y, m - 1, d) / DAY - ymd(now));
}

/** 今日 / 明日 / 3日後 / 2日超過 / 14日以上先は月日。`late` marks overdue. */
export function relativeDue(
	due: string,
	now = new Date(),
): { text: string; late: boolean } {
	const n = daysUntil(due, now);
	if (n < 0) return { text: t("due.overdue", { n: -n }), late: true };
	if (n < 2) return { text: rtf.format(n, "day"), late: false }; // 今日 / 明日
	if (n < 14) return { text: t("due.in", { n }), late: false };
	const [, m = 1, d = 1] = due.split("-").map(Number);
	return { text: t("due.date", { m, d }), late: false };
}

export const absoluteDate = (due: string) =>
	dateFmt.format(new Date(`${due}T00:00:00`));

/** たった今 / 5分前 / 3時間前 / 2日前 / then the date. */
export function relativeTime(iso: string | number | Date, now = new Date()) {
	const at = new Date(iso);
	const s = Math.round((now.getTime() - at.getTime()) / 1000);
	if (s < 60) return t("time.now");
	if (s < 3600) return t("time.min", { n: Math.floor(s / 60) });
	if (s < DAY / 1000) return t("time.hour", { n: Math.floor(s / 3600) });
	if (s < 7 * (DAY / 1000))
		return t("time.day", { n: Math.floor(s / (DAY / 1000)) });
	return at.toLocaleDateString("ja-JP");
}

/** 「Claude Code経由」 / 「<client>経由」 for mcp:<client> / the dictionary's via.* / the raw value. */
export function viaLabel(via: string): string {
	const key = `via.${via}`;
	if (key in ja) return t(key as Key);
	return via.startsWith("mcp:") ? t("via.mcp", { client: via.slice(4) }) : via;
}

/** First character of the family-name part: "鈴木 康" → "鈴", "Ada Lovelace" → "A". */
export const initialOf = (name: string) =>
	[...(name.trim() || "?")][0]?.toUpperCase() ?? "?";

/** Stable muted hue (0-359) from an id, so one person is always the same colour. */
export function hueOf(id: string): number {
	let h = 0;
	for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
	return h;
}

/** "1. foo\n2) bar" → numbered steps; null when the text is not a plain numbered list. */
export function splitSteps(md: string): { n: string; text: string }[] | null {
	const out: { n: string; text: string }[] = [];
	for (const line of md.split("\n")) {
		if (!line.trim()) continue;
		const m = /^\s*(\d+)[.)．、]\s*(.*)$/.exec(line);
		if (m) out.push({ n: m[1] ?? "", text: m[2] ?? "" });
		else return null;
	}
	return out.length ? out : null;
}

/** Which steps cover a criterion: "1, 2、4" → ["1","2","4"]. */
export const stepRefs = (ref: string | null | undefined): string[] =>
	(ref ?? "").split(/[,、，\s]+/).filter(Boolean);

export const memberName = (members: Member[], id: string | null) =>
	members.find((m) => m.id === id)?.name ?? t("unknown.user");

const known = (prefix: string, k: string) =>
	`${prefix}.${k}` in ja ? t(`${prefix}.${k}` as Key) : k;

/** A stored before/after value as the reader should see it (names, not ids). */
function shownValue(
	field: string,
	v: string | null,
	ctx: { members: Member[]; statuses: Status[] },
): string {
	if (
		field === "assigneeId" ||
		field === "approverId" ||
		field === "reporterId"
	)
		return v ? memberName(ctx.members, v) : t("assignee.none");
	if (v === null) return "";
	if (field === "statusId")
		return ctx.statuses.find((s) => s.id === v)?.name ?? v;
	if (field === "priority") {
		const k = PRIORITY_KEYS[Number(v)];
		return k ? t(k) : v;
	}
	if (field === "flow")
		return t(v === "ai" ? "list.create.ai" : "list.create.human");
	return v;
}

/** One line of the history: 「担当を「A」から「B」に変更」 etc. */
export function activityText(
	a: Pick<Activity, "action" | "field" | "before" | "after">,
	ctx: { members: Member[]; statuses: Status[] },
): string {
	if (!a.field) return known("act", a.action);
	const field = known("field", a.field);
	const long = (a.before ?? "").length > 40 || (a.after ?? "").length > 40;
	if (long || a.field === "criteria") return t("act.changed", { field });
	const after = shownValue(a.field, a.after, ctx);
	return a.before
		? t("act.change", {
				field,
				before: shownValue(a.field, a.before, ctx),
				after,
			})
		: t("act.set", { field, after });
}
