import type { ReactNode } from "react";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown";

function Inlines({ nodes }: { nodes: Inline[] }): ReactNode {
	return nodes.map((n, i) => {
		const k = `${i}`;
		switch (n.t) {
			case "text":
				return n.s;
			case "strong":
				return (
					<strong key={k}>
						<Inlines nodes={n.c} />
					</strong>
				);
			case "em":
				return (
					<em key={k}>
						<Inlines nodes={n.c} />
					</em>
				);
			case "code":
				return (
					<code key={k} className="rounded-chip bg-paper px-1 text-[0.9em]">
						{n.s}
					</code>
				);
			case "link":
				return (
					<a
						key={k}
						href={n.href}
						target="_blank"
						rel="noopener noreferrer"
						className="text-ai-indigo underline"
					>
						{n.s}
					</a>
				);
			case "image":
				return (
					<a key={k} href={n.src} target="_blank" rel="noopener noreferrer">
						<img
							src={n.src}
							alt={n.alt}
							loading="lazy"
							referrerPolicy="no-referrer"
							className="my-1 max-h-80 max-w-full rounded-control border border-line"
						/>
					</a>
				);
			default:
				return null;
		}
	});
}

function BlockView({ b }: { b: Block }) {
	switch (b.t) {
		case "h":
			return (
				<p className="mt-3 mb-1 font-semibold first:mt-0">
					<Inlines nodes={b.c} />
				</p>
			);
		case "code":
			return (
				<pre className="my-2 overflow-x-auto rounded-control bg-paper p-2.5 text-sm leading-relaxed whitespace-pre">
					<code>{b.s}</code>
				</pre>
			);
		case "quote":
			return (
				<blockquote className="my-2 border-l-2 border-ai-indigo/40 pl-3 text-nezumi">
					<Inlines nodes={b.c} />
				</blockquote>
			);
		case "list": {
			const L = b.ordered ? "ol" : "ul";
			return (
				<L
					className={`my-1.5 pl-5 ${b.ordered ? "list-decimal" : "list-disc"}`}
				>
					{b.items.map((it, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static list built from text
						<li key={i}>
							<Inlines nodes={it} />
						</li>
					))}
				</L>
			);
		}
		default:
			return (
				<p className="my-1.5 first:mt-0 last:mb-0">
					<Inlines nodes={b.c} />
				</p>
			);
	}
}

/** Markdown as React elements: no raw HTML, http(s) links, own/https images only. */
export function Markdown({
	md,
	className,
}: {
	md: string;
	className?: string;
}) {
	return (
		<div className={`whitespace-pre-wrap ${className ?? ""}`}>
			{parseMarkdown(md).map((b, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: derived from the text, order is the identity
				<BlockView key={i} b={b} />
			))}
		</div>
	);
}
