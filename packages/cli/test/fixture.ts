import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addComment,
	type Ctx,
	createIssue,
	createProject,
	updateCriteria,
} from "@tasuki/core";
import { openDb, users } from "@tasuki/db";

export const tmp = () => mkdtempSync(join(tmpdir(), "tasuki-cli-"));

/** A data dir with an admin, project WEB, and one issue with a criterion and a comment. */
export function seededData() {
	const data = tmp();
	const db = openDb(join(data, "tasuki.db"));
	const admin = db
		.insert(users)
		.values({
			email: "a@example.com",
			name: "Alice",
			passwordHash: "x",
			role: "admin",
		})
		.returning()
		.get();
	const ctx: Ctx = {
		db,
		actor: { userId: admin.id, via: "web", auth: "session" },
	};
	createProject(ctx, { key: "WEB", name: "Web" });
	const issue = createIssue(ctx, "WEB", {
		title: 'Fix "login"',
		bodyMd: "Login fails on **Safari**.",
		labels: ["bug"],
		assigneeId: admin.id,
	});
	updateCriteria(ctx, issue.ref, [{ text: "Safari can log in" }]);
	addComment(ctx, issue.ref, "Reproduced.");
	db.$client.close();
	return { data, ref: issue.ref };
}
