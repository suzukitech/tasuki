import { CircleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";
import { t } from "../i18n";
import { cx, iconProps, inputCls } from "./ui";

/** Centered 360px column used by the auth pages and the new-project form. */
export function Column({
	title,
	lead,
	children,
	full,
}: {
	title: string;
	lead?: string;
	children: ReactNode;
	/** fill the viewport and centre vertically (auth pages, outside the sidebar layout) */
	full?: boolean;
}) {
	return (
		<main
			className={cx(
				"mx-auto flex w-full max-w-[360px] flex-col px-4",
				full ? "min-h-full justify-center py-12" : "pt-16 pb-12",
			)}
		>
			{full && (
				<span className="mb-8 text-xl font-semibold tracking-tight text-ai-indigo">
					{t("app.name")}
				</span>
			)}
			<h1 className="text-xl font-semibold">{title}</h1>
			{lead && (
				<p className="mt-2 text-sm leading-relaxed text-nezumi">{lead}</p>
			)}
			<div className="mt-6">{children}</div>
		</main>
	);
}

/** Label, input, optional hint, and the error right under the field. */
export function Field({
	label,
	error,
	hint,
	className,
	...p
}: {
	label: string;
	error?: string;
	hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
	const id = useId();
	const note = `${id}-note`;
	return (
		<div className="mb-4">
			<label htmlFor={id} className="mb-1 block text-sm font-medium">
				{label}
			</label>
			<input
				{...p}
				id={id}
				aria-invalid={!!error}
				aria-describedby={error || hint ? note : undefined}
				className={cx(
					inputCls,
					"h-9 pointer-coarse:h-11",
					error && "border-sash",
					className,
				)}
			/>
			{error ? (
				<p
					id={note}
					role="alert"
					className="mt-1.5 flex items-start gap-1.5 text-xs text-sash"
				>
					<CircleAlert {...iconProps} className="mt-px shrink-0" />
					{error}
				</p>
			) : (
				hint && (
					<p id={note} className="mt-1.5 text-xs text-nezumi">
						{hint}
					</p>
				)
			)}
		</div>
	);
}
