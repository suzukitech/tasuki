export type KeyLike = {
	key: string;
	isComposing?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	target: {
		tagName?: string;
		isContentEditable?: boolean;
		closest?: (selector: string) => unknown;
	} | null;
};
export type KeyAction =
	| "create"
	| "next"
	| "prev"
	| "open"
	| "close"
	| "search";

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** One-letter shortcuts must not fire while typing, composing (IME) or with a modifier held. */
export function shouldHandleKey(e: KeyLike): boolean {
	if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
	const t = e.target;
	if (t?.isContentEditable) return false;
	// keys inside an open Menu belong to the menu
	if (t?.closest?.("[role=listbox],[role=menu]")) return false;
	return !(t?.tagName && TYPING.has(t.tagName.toUpperCase()));
}

const MAP: Record<string, KeyAction> = {
	c: "create",
	j: "next",
	k: "prev",
	Enter: "open",
	Escape: "close",
	"/": "search",
};

export function keyAction(e: KeyLike): KeyAction | null {
	if (!shouldHandleKey(e)) return null;
	const a = MAP[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
	// Enter on a focused button/link already activates it
	if (
		a === "open" &&
		["BUTTON", "A"].includes(e.target?.tagName?.toUpperCase() ?? "")
	)
		return null;
	return a;
}
