import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api";
import { writeError } from "../src/lib/etag";
import { inline, parseMarkdown, safeImage, safeUrl } from "../src/lib/markdown";
import { markdownImage, uploadProblem } from "../src/lib/upload";

describe("markdown is safe", () => {
	test("links: http(s) only", () => {
		expect(safeUrl("https://a.example")).toBe("https://a.example");
		expect(safeUrl("javascript:alert(1)")).toBeUndefined();
		expect(safeUrl("data:text/html,x")).toBeUndefined();
		expect(inline("[x](javascript:alert)")).toEqual([{ t: "text", s: "x" }]);
		expect(inline("[x](https://a.example)")).toEqual([
			{ t: "link", href: "https://a.example", s: "x" },
		]);
	});

	test("images: own attachments only; external images become links", () => {
		expect(safeImage("/api/v1/attachments/0198-abc")).toBeTruthy();
		expect(safeImage("/api/v1/attachments/../../x")).toBeUndefined();
		expect(safeImage("https://x.example/a.png")).toBeUndefined();
		expect(safeImage("http://x.example/a.png")).toBeUndefined();
		expect(safeImage("//evil.example/a.png")).toBeUndefined();
		expect(safeImage("javascript:alert(1)")).toBeUndefined();
		expect(inline("![pic](javascript:alert)")).toEqual([
			{ t: "text", s: "pic" },
		]);
		expect(inline("![pic](/api/v1/attachments/a1)")[0]).toEqual({
			t: "image",
			src: "/api/v1/attachments/a1",
			alt: "pic",
		});
	});

	test("raw HTML stays text (the renderer never emits HTML)", () => {
		const b = parseMarkdown(
			"<img src=x onerror=alert(1)>\n<script>alert(1)</script>",
		);
		expect(b).toEqual([
			{
				t: "p",
				c: [
					{
						t: "text",
						s: "<img src=x onerror=alert(1)>\n<script>alert(1)</script>",
					},
				],
			},
		]);
	});

	test("blocks and inline formatting", () => {
		const b = parseMarkdown(
			"# T\n\ntext **b** *i* `c`\nnext\n\n- a\n- b\n\n1. x\n\n> q\n\n```\ncode **x**\n```",
		);
		expect(b.map((x) => x.t)).toEqual([
			"h",
			"p",
			"list",
			"list",
			"quote",
			"code",
		]);
		expect(b[2]).toMatchObject({ ordered: false });
		expect(b[3]).toMatchObject({ ordered: true });
		expect(b[5]).toEqual({ t: "code", s: "code **x**" });
		expect(
			(b[1] as { c: unknown[] }).c.map((n) => (n as { t: string }).t),
		).toEqual(["text", "strong", "text", "em", "text", "code", "text"]);
	});
});

describe("upload helpers", () => {
	test("type and size are checked in Japanese", () => {
		expect(uploadProblem({ type: "image/png", size: 100 })).toBeNull();
		expect(uploadProblem({ type: "image/svg+xml", size: 100 })).toContain(
			"形式",
		);
		expect(
			uploadProblem({ type: "image/png", size: 11 * 1024 * 1024 }),
		).toContain("大きすぎ");
	});

	test("markdownImage cannot be broken out of", () => {
		expect(markdownImage("a](x) ![b", "/api/v1/attachments/1")).toBe(
			"![ax !b](/api/v1/attachments/1)",
		);
		expect(markdownImage("", "/u")).toBe("![image](/u)");
	});

	test("413 and 415 become Japanese write errors", () => {
		expect(
			writeError(new ApiError(413, "too_large", "image over 10 MB")).text,
		).toContain("10MB");
		expect(
			writeError(new ApiError(415, "unsupported_media", "only png")).text,
		).toContain("PNG");
	});
});

describe("uploadImage", () => {
	const real = globalThis.fetch;
	const file = new File([new Uint8Array([1, 2, 3])], "画面.png", {
		type: "image/png",
	});
	test("sends the raw bytes with the image type and the filename", async () => {
		const { uploadImage } = await import("../src/lib/upload");
		let seen: { url: string; init: RequestInit } | undefined;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return Response.json(
				{ id: "a1", filename: "画面.png", url: "/api/v1/attachments/a1" },
				{ status: 201 },
			);
		}) as unknown as typeof fetch;
		try {
			const up = await uploadImage("WEB-1", file);
			expect(up.url).toBe("/api/v1/attachments/a1");
			expect(seen?.url).toBe(
				`/api/v1/issues/WEB-1/attachments?filename=${encodeURIComponent("画面.png")}`,
			);
			expect(
				((seen?.init.headers ?? {}) as Record<string, string>)["content-type"],
			).toBe("image/png");
			expect(seen?.init.body).toBe(file);
		} finally {
			globalThis.fetch = real;
		}
	});

	test("a refusal becomes an ApiError that writeError words in Japanese", async () => {
		const { uploadImage } = await import("../src/lib/upload");
		globalThis.fetch = (async () =>
			Response.json(
				{ code: "too_large", detail: "image over 10 MB" },
				{ status: 413 },
			)) as unknown as typeof fetch;
		try {
			const e = await uploadImage("WEB-1", file).catch((x) => x);
			expect(e).toBeInstanceOf(ApiError);
			expect(writeError(e).text).toContain("10MB");
		} finally {
			globalThis.fetch = real;
		}
	});

	test("a non-JSON failure still becomes an ApiError", async () => {
		const { uploadImage } = await import("../src/lib/upload");
		globalThis.fetch = (async () =>
			new Response("<html>bad gateway</html>", {
				status: 502,
			})) as unknown as typeof fetch;
		try {
			const e = await uploadImage("WEB-1", file).catch((x) => x);
			expect(e).toBeInstanceOf(ApiError);
			expect(e.status).toBe(502);
		} finally {
			globalThis.fetch = real;
		}
	});
});
