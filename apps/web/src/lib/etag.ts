import { ApiError } from "./api";

/** `If-Match` value for an issue: its updatedAt (ISO string from the API) in ms, quoted. */
export const etagOf = (updatedAt: string) => `"${Date.parse(updatedAt)}"`;

export type WriteError = {
	/** 412: somebody else changed it first; the caller refetches */
	conflict: boolean;
	/** i18n key of the toast */
	key:
		| "toast.conflict"
		| "toast.forbidden"
		| "toast.gate"
		| "toast.network"
		| "toast.failed";
	/** server's detail, appended for generic failures */
	detail?: string;
};

/** Map a failed write to the toast to show and whether to refetch. */
export function writeError(e: unknown): WriteError {
	if (!(e instanceof ApiError))
		return { conflict: false, key: "toast.network" };
	if (e.status === 412) return { conflict: true, key: "toast.conflict" };
	if (e.status === 403) return { conflict: false, key: "toast.forbidden" };
	if (e.code === "gate") return { conflict: false, key: "toast.gate" };
	return { conflict: false, key: "toast.failed", detail: e.message };
}
