import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachments } from "@tasuki/db";
import {
	addAttachment,
	cleanFilename,
	createTemplate,
	createWebhook,
	deleteIssue,
	deleteTemplate,
	deleteWebhook,
	getAttachment,
	listTemplates,
	listWebhooks,
	maskUrl,
	sniffImage,
	type TasukiError,
	testText,
	updateTemplate,
	webhookForTest,
	webhookTargets,
	webhookText,
} from "../src/index";
import { setup } from "./fixture";

const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		return (e as TasukiError).code;
	}
};
const HOOK = "https://hooks.slack.com/services/T000/B000/SECRETabcd";

describe("webhooks", () => {
	test("manager + session only; URL masked; fixed events", () => {
		const w = setup();
		const w1 = createWebhook(w.ctx(w.u.mgr), "WEB", {
			url: HOOK,
			events: ["plan.submitted", "plan.submitted", "issue.completed"],
		});
		expect(w1.url).toBe("https://hooks.slack.com/…abcd");
		expect(w1.events).toEqual(["plan.submitted", "issue.completed"]);
		expect(JSON.stringify(listWebhooks(w.ctx(w.u.mgr), "WEB"))).not.toContain(
			"SECRET",
		);
		expect(code(() => listWebhooks(w.ctx(w.u.mem), "WEB"))).toBe("forbidden");
		expect(code(() => listWebhooks(w.ctx(w.u.mgr, "token"), "WEB"))).toBe(
			"gate",
		);
		expect(
			code(() =>
				createWebhook(w.ctx(w.u.mgr), "WEB", {
					url: "ftp://x",
					events: ["plan.submitted"],
				}),
			),
		).toBe("invalid");
		expect(
			code(() =>
				createWebhook(w.ctx(w.u.mgr), "WEB", { url: HOOK, events: ["nope"] }),
			),
		).toBe("invalid");
		expect(webhookForTest(w.ctx(w.u.mgr), "WEB", w1.id).url).toBe(HOOK);
		expect(maskUrl("garbage")).toBe("…");
		deleteWebhook(w.ctx(w.u.mgr), "WEB", w1.id);
		expect(code(() => deleteWebhook(w.ctx(w.u.mgr), "WEB", w1.id))).toBe(
			"not_found",
		);
	});

	test("limit per project; targets filter by event; text escapes and links", () => {
		const w = setup();
		for (let i = 0; i < 10; i++)
			createWebhook(w.ctx(w.u.mgr), "WEB", {
				url: `${HOOK}${i}`,
				events: ["question.asked"],
			});
		expect(
			code(() =>
				createWebhook(w.ctx(w.u.mgr), "WEB", {
					url: HOOK,
					events: ["question.asked"],
				}),
			),
		).toBe("conflict");
		const i = w.issue({ title: "a <b> & c" });
		const e = {
			type: "question.asked",
			projectId: w.project.id,
			ref: i.ref,
		} as const;
		expect(webhookTargets(w.db, e)).toHaveLength(10);
		expect(webhookTargets(w.db, { ...e, type: "plan.submitted" })).toHaveLength(
			0,
		);
		expect(webhookTargets(w.db, { ...e, type: "issue.updated" })).toEqual([]);
		const text = webhookText(w.db, e, "https://t.example/");
		expect(text).toContain("*WEB-1* a &lt;b&gt; &amp; c");
		expect(text).toContain("https://t.example/p/WEB?issue=WEB-1");
		expect(webhookText(w.db, { ...e, type: "issue.updated" }, "x")).toBeNull();
		expect(webhookText(w.db, { ...e, ref: "WEB-99" }, "x")).toBeNull();
		expect(testText()).toContain("テスト");
	});
});

describe("templates", () => {
	test("CRUD for managers; members and viewers read", () => {
		const w = setup();
		const t = createTemplate(w.ctx(w.u.mgr), "WEB", {
			name: "Bug",
			bodyTemplateMd: "## 手順",
		});
		expect(listTemplates(w.ctx(w.u.view), "WEB").map((x) => x.name)).toEqual([
			"Bug",
		]);
		expect(
			code(() => createTemplate(w.ctx(w.u.mem), "WEB", { name: "x" })),
		).toBe("forbidden");
		expect(
			code(() => createTemplate(w.ctx(w.u.mgr, "token"), "WEB", { name: "x" })),
		).toBe("gate");
		expect(
			code(() => createTemplate(w.ctx(w.u.mgr), "WEB", { name: "" })),
		).toBe("invalid");
		expect(
			code(() =>
				createTemplate(w.ctx(w.u.mgr), "WEB", { name: "x", typeId: "nope" }),
			),
		).toBe("invalid");
		const up = updateTemplate(w.ctx(w.u.mgr), "WEB", t.id, {
			bodyTemplateMd: "new",
		});
		expect(up.bodyTemplateMd).toBe("new");
		expect(up.name).toBe("Bug");
		expect(updateTemplate(w.ctx(w.u.mgr), "WEB", t.id, {}).name).toBe("Bug");
		const ren = updateTemplate(w.ctx(w.u.mgr), "WEB", t.id, { name: "Bug2" });
		expect(ren.name).toBe("Bug2");
		expect(ren.bodyTemplateMd).toBe("new"); // a rename must not wipe the body
		expect(
			code(() => updateTemplate(w.ctx(w.u.mgr), "WEB", "zzz", { name: "q" })),
		).toBe("not_found");
		deleteTemplate(w.ctx(w.u.mgr), "WEB", t.id);
		expect(code(() => deleteTemplate(w.ctx(w.u.mgr), "WEB", t.id))).toBe(
			"not_found",
		);
		expect(listTemplates(w.ctx(w.u.mgr), "WEB")).toEqual([]);
	});
});

describe("attachments", () => {
	const png = Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
	]);
	test("sniff by magic bytes", () => {
		expect(sniffImage(png)).toBe("image/png");
		expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
			"image/jpeg",
		);
		expect(sniffImage(new TextEncoder().encode("GIF89a.."))).toBe("image/gif");
		expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe(
			"image/webp",
		);
		expect(sniffImage(new TextEncoder().encode("<svg onload=x>"))).toBeNull();
		expect(sniffImage(new Uint8Array())).toBeNull();
	});

	test("filename is display-only", () => {
		expect(cleanFilename('../../etc/pa"sswd\n')).toBe("....etcpasswd");
		expect(cleanFilename("")).toBe("image");
		expect(cleanFilename("a".repeat(300))).toHaveLength(100);
	});

	test("members attach, viewers cannot; read follows project access; delete returns paths", () => {
		const w = setup();
		const i = w.issue();
		const f = {
			id: "a1",
			filename: "x.png",
			size: 9,
			contentType: "image/png",
			path: "attachments/a1",
		};
		expect(code(() => addAttachment(w.ctx(w.u.view), i.ref, f))).toBe(
			"forbidden",
		);
		expect(
			code(() =>
				addAttachment(w.ctx(w.u.mem), i.ref, { ...f, size: 11 * 1024 * 1024 }),
			),
		).toBe("invalid");
		addAttachment(w.ctx(w.u.mem, "token"), i.ref, f);
		expect(getAttachment(w.ctx(w.u.view), "a1").contentType).toBe("image/png");
		expect(code(() => getAttachment(w.ctx(w.u.out), "a1"))).toBe("forbidden");
		expect(code(() => getAttachment(w.ctx(w.u.mem), "zz"))).toBe("not_found");
		const dir = mkdtempSync(join(tmpdir(), "tasuki-"));
		mkdirSync(join(dir, "attachments"));
		writeFileSync(join(dir, "attachments/a1"), "x");
		expect(deleteIssue({ ...w.ctx(w.u.mgr), dataDir: dir }, i.ref)).toEqual([
			"attachments/a1",
		]);
		expect(existsSync(join(dir, "attachments/a1"))).toBe(false);
		rmSync(dir, { recursive: true });
		expect(w.db.select().from(attachments).all()).toEqual([]);
	});
});
