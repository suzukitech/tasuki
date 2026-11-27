import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useWriteFailure } from "../lib/queries";
import { markdownImage, uploadImage, uploadProblem } from "../lib/upload";
import { Markdown } from "./Markdown";
import { cx, inputCls, useToast } from "./ui";

/**
 * Markdown text with a preview toggle. Pasting or dropping an image uploads it to the
 * issue and inserts `![name](/api/v1/attachments/<id>)` at the cursor. Without `issueRef`
 * (nothing to attach to yet) images are refused rather than lost.
 */
export function MarkdownEditor(p: {
	id: string;
	value: string;
	onChange: (v: string) => void;
	issueRef?: string;
	rows?: number;
	label?: string;
	placeholder?: string;
}) {
	const ta = useRef<HTMLTextAreaElement>(null);
	const [preview, setPreview] = useState(false);
	const [busy, setBusy] = useState(0);
	const toast = useToast();
	const fail = useWriteFailure();
	// the textarea may have changed while an upload ran: always insert into the live value
	const live = useRef(p.value);
	live.current = p.value;

	// uploads that finish after unmount must not touch the editor or toast
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	/** Upload the files one by one, each landing after the previous one at the caret. */
	const attach = async (files: File[]) => {
		const problems = new Set<string>();
		const ok: File[] = [];
		for (const f of files) {
			const why = uploadProblem(f);
			if (why) problems.add(why);
			else ok.push(f);
		}
		for (const why of problems) toast(why);
		if (!ok.length) return;
		if (!p.issueRef) return toast(t("editor.saveFirst"));
		const el = ta.current;
		let pos = el?.selectionStart ?? live.current.length;
		let end = el?.selectionEnd ?? pos;
		let inserted = 0;
		for (const f of ok) {
			setBusy((n) => n + 1);
			try {
				const up = await uploadImage(p.issueRef, f);
				if (!alive.current) return;
				const cur = live.current;
				const at = Math.min(pos, cur.length);
				const lead = at > 0 && cur[at - 1] !== "\n" ? "\n" : "";
				const md = `${lead}${markdownImage(f.name || up.filename, up.url)}\n`;
				const next = cur.slice(0, at) + md + cur.slice(Math.max(at, end));
				live.current = next;
				p.onChange(next);
				pos = end = at + md.length;
				inserted++;
			} catch (e) {
				if (alive.current) fail(e);
			} finally {
				setBusy((n) => n - 1);
			}
		}
		if (inserted && alive.current) toast(t("editor.uploaded"), "success");
	};

	const hasFiles = (dt: DataTransfer) => dt.files.length > 0;

	return (
		<div>
			<div className="mb-1 flex items-center gap-3 text-xs">
				{(
					[
						[false, "editor.write"],
						[true, "editor.preview"],
					] as const
				).map(([v, k]) => (
					<button
						key={k}
						type="button"
						aria-pressed={preview === v}
						onClick={() => setPreview(v)}
						className={cx(
							"-mb-px min-h-7 rounded-chip border-b-2 px-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
							preview === v
								? "border-ai-indigo font-medium text-ai-indigo"
								: "border-transparent text-nezumi hover:text-ink",
						)}
					>
						{t(k)}
					</button>
				))}
				<span role="status" aria-live="polite" className="ml-auto text-nezumi">
					{busy > 0
						? t("editor.uploading")
						: p.issueRef
							? t("editor.hint")
							: ""}
				</span>
			</div>
			{preview ? (
				<div
					className={cx(
						inputCls,
						"min-h-24 overflow-auto bg-paper leading-relaxed",
					)}
				>
					{p.value.trim() ? (
						<Markdown md={p.value} />
					) : (
						<span className="text-nezumi">{t("editor.empty")}</span>
					)}
				</div>
			) : (
				<textarea
					ref={ta}
					id={p.id}
					rows={p.rows ?? 6}
					aria-label={p.label}
					placeholder={p.placeholder}
					className={cx(inputCls, "leading-relaxed")}
					value={p.value}
					onChange={(e) => p.onChange(e.target.value)}
					onPaste={(e) => {
						if (!hasFiles(e.clipboardData)) return;
						e.preventDefault();
						void attach([...e.clipboardData.files]);
					}}
					onDragOver={(e) => {
						if (e.dataTransfer.types.includes("Files")) e.preventDefault();
					}}
					onDrop={(e) => {
						if (!hasFiles(e.dataTransfer)) return;
						e.preventDefault();
						void attach([...e.dataTransfer.files]);
					}}
				/>
			)}
		</div>
	);
}
