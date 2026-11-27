export type TokenRow = {
	id: string;
	name: string;
	/** JSON text, e.g. '["read","write"]' */
	scopes: string;
	/** JSON text of project ids, or null for all projects */
	projectIds: string | null;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
	createdAt: string;
};

export type TokenState = "active" | "revoked" | "expired";

const parse = <T>(s: string | null, fallback: T): T => {
	try {
		return s ? (JSON.parse(s) as T) : fallback;
	} catch {
		return fallback;
	}
};

/** What the list needs from a stored token: its scope, project limit and whether it still works. */
export function tokenView(row: TokenRow, now = new Date()) {
	const scopes = parse<string[]>(row.scopes, []);
	const state: TokenState = row.revokedAt
		? "revoked"
		: row.expiresAt && new Date(row.expiresAt) <= now
			? "expired"
			: "active";
	return {
		write: scopes.includes("write"),
		projectIds: parse<string[] | null>(row.projectIds, null),
		state,
	};
}

/** `<input type="date">` value → end of that local day as ISO 8601 (the API wants a future instant). */
export const expiryIso = (date: string): string | null =>
	date ? new Date(`${date}T23:59:59`).toISOString() : null;
