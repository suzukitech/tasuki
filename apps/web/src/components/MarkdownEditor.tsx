import { useRef, useState } from "react";
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

	const attach = async (files: File[]) => {
		const imgs = files.filter((f) => f.type.startsWith("image/"));
		if (!imgs.length || !p.issueRef) return false;
		for (const f of imgs) {
			const problem = uploadProblem(f);
			if (problem) {
				toast(problem);
				continue;
			}
			setBusy((n) => n + 1);
			try {
				const up = await uploadImage(p.issueRef, f);
				const el = ta.current;
				const at = el?.selectionStart ?? live.current.length;
				const end = el?.selectionEnd ?? at;
				const cur = live.current;
				const md = markdownImage(f.name || up.filename, up.url);
				const next = `${cur.slice(0, at)}${at > 0 && cur[at - 1] !== "\n" ? "\n" : ""}${md}\n${cur.slice(end)}`;
				live.current = next;
				p.onChange(next);
				toast(t("editor.uploaded"), "success");
			} catch (e) {
				fail(e);
			} finally {
				setBusy((n) => n - 1);
			}
		}
		return true;
	};

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
							"-mb-px min-h-7 rounded-chip border-b-2 px-1 pointer-coarse:min-h-11",
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
						const files = [...e.clipboardData.files];
						if (files.some((f) => f.type.startsWith("image/")) && p.issueRef) {
							e.preventDefault();
							void attach(files);
						}
					}}
					onDragOver={(e) => {
						if (p.issueRef && e.dataTransfer.types.includes("Files"))
							e.preventDefault();
					}}
					onDrop={(e) => {
						if (!p.issueRef) return;
						const files = [...e.dataTransfer.files];
						if (files.some((f) => f.type.startsWith("image/"))) {
							e.preventDefault();
							void attach(files);
						}
					}}
				/>
			)}
		</div>
	);
}
