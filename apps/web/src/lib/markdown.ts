// Markdown subset → a small tree. No raw HTML is ever produced: the renderer turns this tree
// into React elements, and anything unsafe (script URLs, foreign images) degrades to plain text.

export type Inline =
	| { t: "text"; s: string }
	| { t: "strong" | "em"; c: Inline[] }
	| { t: "code"; s: string }
	| { t: "link"; href: string; s: string }
	| { t: "image"; src: string; alt: string };
export type Block =
	| { t: "p"; c: Inline[] }
	| { t: "h"; level: number; c: Inline[] }
	| { t: "code"; s: string }
	| { t: "quote"; c: Inline[] }
	| { t: "list"; ordered: boolean; items: Inline[][] };

/** Links: http(s) only. */
export const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);
/**
 * Inline images: our own attachments only. An external image would be a tracking pixel
 * (it leaks the viewer's IP and view time to whoever wrote the comment), so it becomes a link.
 */
export const safeImage = (u: string) =>
	/^\/api\/v1\/attachments\/[\w-]+$/.test(u) ? u : undefined;

const TOKEN =
	/!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;

export function inline(src: string): Inline[] {
	const out: Inline[] = [];
	let last = 0;
	const text = (s: string) => s && out.push({ t: "text", s });
	for (const m of src.matchAll(TOKEN)) {
		text(src.slice(last, m.index));
		last = (m.index ?? 0) + m[0].length;
		if (m[2] !== undefined) {
			const img = safeImage(m[2]);
			const href = safeUrl(m[2]);
			if (img) out.push({ t: "image", src: img, alt: m[1] ?? "" });
			else if (href) out.push({ t: "link", href, s: m[1] || href });
			else text(m[1] || m[0]);
		} else if (m[4] !== undefined) {
			const href = safeUrl(m[4]);
			if (href) out.push({ t: "link", href, s: m[3] ?? "" });
			else text(m[3] ?? "");
		} else if (m[5] !== undefined) out.push({ t: "code", s: m[5] });
		else if (m[6] !== undefined) out.push({ t: "strong", c: inline(m[6]) });
		else if (m[7] !== undefined) out.push({ t: "em", c: inline(m[7]) });
	}
	text(src.slice(last));
	return out;
}

export function parseMarkdown(md: string): Block[] {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: Block[] = [];
	let i = 0;
	const para: string[] = [];
	const flush = () => {
		if (para.length) out.push({ t: "p", c: inline(para.join("\n")) });
		para.length = 0;
	};
	while (i < lines.length) {
		const line = lines[i] ?? "";
		let m: RegExpExecArray | null;
		if (/^```/.test(line)) {
			flush();
			const code: string[] = [];
			for (i++; i < lines.length && !/^```/.test(lines[i] ?? ""); i++)
				code.push(lines[i] ?? "");
			i++;
			out.push({ t: "code", s: code.join("\n") });
		} else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
			flush();
			out.push({ t: "h", level: (m[1] ?? "#").length, c: inline(m[2] ?? "") });
			i++;
		} else if (/^>\s?/.test(line)) {
			flush();
			const q: string[] = [];
			for (; i < lines.length && /^>\s?/.test(lines[i] ?? ""); i++)
				q.push((lines[i] ?? "").replace(/^>\s?/, ""));
			out.push({ t: "quote", c: inline(q.join("\n")) });
		} else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
			flush();
			const ordered = /^\s*\d+\./.test(line);
			const items: Inline[][] = [];
			for (; i < lines.length; i++) {
				const it = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(lines[i] ?? "");
				if (!it) break;
				items.push(inline(it[1] ?? ""));
			}
			out.push({ t: "list", ordered, items });
		} else if (!line.trim()) {
			flush();
			i++;
		} else {
			para.push(line);
			i++;
		}
	}
	flush();
	return out;
}
