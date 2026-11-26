import { generateNKeysBetween } from "fractional-indexing";
import type { Conn, Db } from "./index";

/** A db handle or a transaction: anything with insert/select. */
type Tx = Pick<Conn, "insert">;

import {
	issues,
	issueTemplates,
	issueTypes,
	projectMembers,
	projects,
	statuses,
} from "./schema";

export const DEFAULT_STATUSES = [
	{ name: "下書き", category: "draft", color: "#9ca3af" },
	{ name: "着手待ち", category: "ready", color: "#3b82f6" },
	{ name: "計画確認", category: "plan_review", color: "#f59e0b" },
	{ name: "作業中", category: "in_progress", color: "#8b5cf6" },
	{ name: "結果確認", category: "impl_review", color: "#ec4899" },
	{ name: "完了", category: "done", color: "#22c55e" },
] as const;

export const DEFAULT_ISSUE_TYPES = ["タスク", "バグ", "エピック"] as const;

export const DEFAULT_TEMPLATES = [
	{
		name: "機能追加",
		bodyTemplateMd:
			"## 背景\n誰が何に困っているか\n\n## やりたいこと\n\n## やらないこと\n",
		criteria: ["期待する動作を確認できる", "テストが追加されている"],
	},
	{
		name: "バグ修正",
		bodyTemplateMd:
			"## 再現手順\n1. \n\n## 期待する動作\n\n## 実際の動作\n\n## 環境\n",
		criteria: ["再現手順で不具合が起きない", "再発防止のテストがある"],
	},
	{
		name: "調査",
		bodyTemplateMd: "## 知りたいこと\n\n## 調べる範囲\n\n## 期限\n",
		criteria: ["結論と根拠がまとまっている"],
	},
	{
		name: "リファクタリング",
		bodyTemplateMd:
			"## 現状の問題\n\n## 目指す構造\n\n## 動作を変えないことの確認方法\n",
		criteria: ["既存のテストがすべて通る", "外部から見た動作が変わらない"],
	},
] as const;

export function createDefaultStatuses(db: Tx, projectId: string) {
	return db
		.insert(statuses)
		.values(
			DEFAULT_STATUSES.map((s, position) => ({ ...s, projectId, position })),
		)
		.returning()
		.all();
}

export function createDefaultIssueTypes(db: Tx, projectId: string) {
	return db
		.insert(issueTypes)
		.values(DEFAULT_ISSUE_TYPES.map((name) => ({ projectId, name })))
		.returning()
		.all();
}

const SAMPLE_ISSUES = [
	{ title: "ログイン画面を作る", type: "タスク", category: "ready" },
	{ title: "パスワード再設定でエラーになる", type: "バグ", category: "draft" },
	{ title: "通知機能", type: "エピック", category: "draft" },
] as const;

export function seedSampleProject(db: Db, ownerUserId: string) {
	return db.transaction((tx) => {
		const project = tx
			.insert(projects)
			.values({
				key: "DEMO",
				name: "サンプルプロジェクト",
				nextNumber: SAMPLE_ISSUES.length + 1,
			})
			.returning()
			.get();
		tx.insert(projectMembers)
			.values({ projectId: project.id, userId: ownerUserId, role: "manager" })
			.run();
		const sts = createDefaultStatuses(tx, project.id);
		const types = createDefaultIssueTypes(tx, project.id);
		tx.insert(issueTemplates)
			.values(
				DEFAULT_TEMPLATES.map((t) => ({
					projectId: project.id,
					name: t.name,
					bodyTemplateMd: t.bodyTemplateMd,
					criteriaTemplate: JSON.stringify(t.criteria),
				})),
			)
			.run();
		const ranks = generateNKeysBetween(null, null, SAMPLE_ISSUES.length);
		tx.insert(issues)
			.values(
				SAMPLE_ISSUES.map((s, i) => ({
					projectId: project.id,
					number: i + 1,
					title: s.title,
					typeId: types.find((t) => t.name === s.type)?.id,
					// biome-ignore lint/style/noNonNullAssertion: every category is in DEFAULT_STATUSES
					statusId: sts.find((x) => x.category === s.category)!.id,
					reporterId: ownerUserId,
					rank: ranks[i] as string,
				})),
			)
			.run();
		return project;
	});
}
