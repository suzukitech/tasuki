import { ATTACHMENT_MAX, ATTACHMENT_TYPES } from "@tasuki/schema/pure";
import { t } from "../i18n";
import { ApiError, csrfToken } from "./api";

export type Uploaded = { id: string; filename: string; url: string };

/** Why this file cannot be attached (Japanese), or null. The server checks again by magic bytes. */
export function uploadProblem(f: { type: string; size: number }) {
	if (!(ATTACHMENT_TYPES as readonly string[]).includes(f.type))
		return t("toast.badType");
	if (f.size > ATTACHMENT_MAX) return t("toast.tooBig");
	return null;
}

/** `![name](url)`: brackets and line breaks stripped from the name so it cannot break out. */
export const markdownImage = (name: string, url: string) =>
	`![${name.replace(/[[\]()\r\n]/g, "").trim() || "image"}](${url})`;

/** Raw image bytes to the issue. Failures are ApiError (the caller shows them via writeError). */
export async function uploadImage(ref: string, file: File): Promise<Uploaded> {
	const token = csrfToken();
	const res = await fetch(
		`/api/v1/issues/${encodeURIComponent(ref)}/attachments?filename=${encodeURIComponent(file.name)}`,
		{
			method: "POST",
			headers: {
				"content-type": file.type,
				...(token && { "x-tasuki-csrf": token }),
			},
			body: file,
			credentials: "same-origin",
		},
	);
	const data = await res.json().catch(() => ({}));
	if (!res.ok)
		throw new ApiError(
			res.status,
			String(data.code ?? "error"),
			String(data.detail ?? res.statusText),
		);
	return data as Uploaded;
}
