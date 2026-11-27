import { attachments } from "@tasuki/db";
import { ATTACHMENT_MAX, type ATTACHMENT_TYPES } from "@tasuki/schema/pure";
import { eq } from "drizzle-orm";
import { atomic, type Ctx, fail, nowOf } from "./ctx";
import { loadIssue, loadIssueById } from "./issues";

type ImageType = (typeof ATTACHMENT_TYPES)[number];

const at = (b: Uint8Array, i: number, s: string) =>
	[...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));

/** The image type the bytes really are (magic numbers), or null. The client's Content-Type is never trusted. */
export function sniffImage(b: Uint8Array): ImageType | null {
	if (
		b[0] === 0x89 &&
		at(b, 1, "PNG") &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	)
		return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (at(b, 0, "GIF87a") || at(b, 0, "GIF89a")) return "image/gif";
	if (at(b, 0, "RIFF") && at(b, 8, "WEBP")) return "image/webp";
	return null;
}

/** Display name only (never a path): no separators or control chars, 100 chars. */
export function cleanFilename(name: string | undefined | null) {
	const n = (name ?? "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\x00-\x1f\x7f/\\"]/g, "")
		.trim()
		.slice(0, 100);
	return n || "image";
}

/** Can the actor attach to this issue? Checked before the body is read. */
export const requireAttach = (ctx: Ctx, ref: string) =>
	void loadIssue(ctx, ref, "member");

export function addAttachment(
	ctx: Ctx,
	ref: string,
	f: {
		id: string;
		filename: string;
		size: number;
		contentType: string;
		path: string;
	},
) {
	if (f.size > ATTACHMENT_MAX) fail("invalid", "attachment too large");
	return atomic(ctx, (c) => {
		const l = loadIssue(c, ref, "member");
		return c.db
			.insert(attachments)
			.values({
				...f,
				filename: cleanFilename(f.filename),
				issueId: l.issue.id,
				uploadedBy: c.actor.userId,
				createdAt: nowOf(c),
			})
			.returning()
			.get();
	});
}

/** Row of an attachment the actor may read (viewer of its issue's project). */
export function getAttachment(ctx: Ctx, id: string) {
	const row = ctx.db
		.select()
		.from(attachments)
		.where(eq(attachments.id, id))
		.get();
	if (!row) return fail("not_found", "attachment not found");
	loadIssueById(ctx, row.issueId);
	return row;
}
