import { t } from "../i18n";
import { ApiError } from "./api";

/** `If-Match` value for an issue: its updatedAt (ISO string from the API) in ms, quoted. */
export const etagOf = (updatedAt: string) => `"${Date.parse(updatedAt)}"`;

export type WriteError = {
	/** 412: somebody else changed it first; the caller refetches */
	conflict: boolean;
	/** plain Japanese: what happened and what to do. Never the server's English text. */
	text: string;
};

/** `prefix` leads the text ("移動できませんでした。"); `to` is the category a move was aimed at. */
export type WriteContext = { prefix?: string; to?: string };

const JAPANESE = /[぀-ヿ一-鿿]/;

/**
 * Map a failed write to the toast text and whether to refetch. The server's `message` is
 * English and meant for API clients, so known refusals are matched on it and rewritten;
 * anything unknown becomes a generic sentence (server detail kept only if it is Japanese).
 */
export function writeError(e: unknown, ctx: WriteContext = {}): WriteError {
	if (!(e instanceof ApiError))
		return { conflict: false, text: t("toast.network") };
	if (e.status === 412) return { conflict: true, text: t("toast.conflict") };
	const lead = ctx.prefix ?? "";
	const m = e.message;
	const body = (() => {
		if (e.status === 413) return t("toast.tooBig");
		if (e.status === 415) return t("toast.badType");
		if (e.status === 403) return t("toast.forbidden");
		if (e.code === "gate" && /review state/.test(m))
			return t("toast.leaveReview");
		if (e.code === "gate" && /approved plan/.test(m)) return t("toast.noPlan");
		if (e.code === "gate" && /session|access token/.test(m))
			return t("toast.gate");
		if (e.code === "invalid" && /review state/.test(m))
			return ctx.to === "plan_review"
				? t("toast.enter.plan_review")
				: ctx.to === "impl_review"
					? t("toast.enter.impl_review")
					: t("toast.enter.any");
		if (e.code === "conflict" && /cannot go from/.test(m))
			return t("toast.badMove");
		if (e.status === 404) return t("toast.notFound");
		return JAPANESE.test(m) ? `${t("toast.failed")}${m}` : t("toast.failed");
	})();
	return { conflict: false, text: lead + body };
}
