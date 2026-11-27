import { isIssueRef } from "@tasuki/schema/pure";
import type { Key } from "../i18n";

export type Cmd = {
	id: string;
	label: string;
	/** i18n key of the small group name shown at the right */
	group: Key;
	/** extra words that also match */
	keywords?: string;
	run: () => void;
	/** the command moves focus itself (e.g. into the quick-create field) */
	takesFocus?: boolean;
};

/** Width- and case-insensitive: "ＷＥＢ" matches "web". */
export const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/**
 * Every whitespace-separated word of the query must appear in the label or keywords.
 * Label-prefix matches come first, then label matches, then keyword-only matches; ties keep their order (Array.sort is stable).
 */
export function filterCommands<T extends Pick<Cmd, "label" | "keywords">>(
	cmds: T[],
	query: string,
): T[] {
	const words = norm(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return cmds;
	const scored: [number, T][] = [];
	for (const c of cmds) {
		const label = norm(c.label);
		const all = `${label} ${norm(c.keywords ?? "")}`;
		if (!words.every((w) => all.includes(w))) continue;
		const score = label.startsWith(words[0] ?? "")
			? 0
			: words.every((w) => label.includes(w))
				? 1
				: 2;
		scored.push([score, c]);
	}
	return scored.sort((a, b) => a[0] - b[0]).map((s) => s[1]);
}

/** "web-12" / "ＷＥＢ－１２" → "WEB-12"; anything else (including WEB-0) → null. */
export function issueRefOf(query: string): string | null {
	const m = /^([a-z]{2,10})-(\d+)$/.exec(
		norm(query)
			.trim()
			.replace(/[‐-―−ー]/g, "-"),
	);
	const ref = m ? `${(m[1] ?? "").toUpperCase()}-${Number(m[2])}` : null;
	return isIssueRef(ref) ? ref : null;
}
