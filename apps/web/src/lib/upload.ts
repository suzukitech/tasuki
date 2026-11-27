import { ATTACHMENT_MAX, ATTACHMENT_TYPES } from "@tasuki/schema/pure";
import { t } from "../i18n";
import { api } from "./api";

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
export const uploadImage = (ref: string, file: File) =>
	api<Uploaded>(
		"POST",
		`/issues/${encodeURIComponent(ref)}/attachments?filename=${encodeURIComponent(file.name)}`,
		file,
	);
