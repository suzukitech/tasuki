/** Display helpers for the list and panel. Pure so they can be tested. */

const DAY = 86_400_000;
const ymd = (d: Date) =>
	Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;

/** Whole days from today (local) to a YYYY-MM-DD due date; negative = overdue. */
export function daysUntil(due: string, now = new Date()): number {
	const [y = 0, m = 1, d = 1] = due.split("-").map(Number);
	return Math.round(Date.UTC(y, m - 1, d) / DAY - ymd(now));
}

/** 今日 / 明日 / 3日後 / 2日超過 / 14日以上先は月日。`late` marks overdue. */
export function relativeDue(
	due: string,
	now = new Date(),
): { text: string; late: boolean } {
	const n = daysUntil(due, now);
	if (n < 0) return { text: `${-n}日超過`, late: true };
	if (n === 0) return { text: "今日", late: false };
	if (n === 1) return { text: "明日", late: false };
	if (n < 14) return { text: `${n}日後`, late: false };
	const [, m = 1, d = 1] = due.split("-").map(Number);
	return { text: `${m}月${d}日`, late: false };
}

const dateFmt = new Intl.DateTimeFormat("ja-JP", {
	year: "numeric",
	month: "long",
	day: "numeric",
	weekday: "short",
});
export const absoluteDate = (due: string) =>
	dateFmt.format(new Date(`${due}T00:00:00`));

/** たった今 / 5分前 / 3時間前 / 2日前 / then the date. */
export function relativeTime(iso: string | number | Date, now = new Date()) {
	const s = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
	if (s < 60) return "たった今";
	if (s < 3600) return `${Math.floor(s / 60)}分前`;
	if (s < DAY / 1000) return `${Math.floor(s / 3600)}時間前`;
	if (s < 7 * (DAY / 1000)) return `${Math.floor(s / (DAY / 1000))}日前`;
	return new Date(iso).toLocaleDateString("ja-JP");
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
