import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n";
import { api } from "../lib/api";
import { projectOf } from "../lib/cache";
import { relativeTime } from "../lib/format";
import { useNotifications, useWriteFailure } from "../lib/queries";
import { cx, iconProps } from "./ui";

/** Sidebar bell: unread count, and a popover of the latest notifications. */
export function NotificationBell() {
	const [open, setOpen] = useState(false);
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const btn = useRef<HTMLButtonElement>(null);
	const nav = useNavigate();
	const qc = useQueryClient();
	const fail = useWriteFailure();
	const { data } = useNotifications();
	const unread = data?.unread ?? 0;
	const read = useMutation({
		mutationFn: (body: { ids: string[] } | { all: true }) =>
			api("POST", "/me/notifications/read", body),
		onError: (e) => fail(e),
		onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
	});
	useEffect(() => {
		if (!open) return;
		const away = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
				btn.current?.focus();
			}
		};
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", esc, true);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", esc, true);
		};
	}, [open]);
	return (
		<div ref={root} className="relative">
			<button
				ref={btn}
				type="button"
				aria-expanded={open}
				aria-controls={id}
				aria-label={`${t("notif.open")}${unread ? `: ${t("notif.unread", { n: unread })}` : ""}`}
				onClick={() => setOpen((o) => !o)}
				className="relative inline-flex h-7 w-7 items-center justify-center rounded-control text-nezumi hover:bg-row-hover hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
			>
				<Bell {...iconProps} />
				{unread > 0 && (
					<span
						aria-hidden
						className="num absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-sash px-1 text-center text-[10px] leading-4 font-medium text-white"
					>
						{unread > 99 ? "99+" : unread}
					</span>
				)}
			</button>
			{open && (
				<div
					id={id}
					role="dialog"
					aria-label={t("notif.title")}
					className="pop absolute bottom-full left-0 z-40 mb-2 w-80 max-w-[calc(100vw-1.5rem)] rounded-panel border border-line bg-surface shadow-float max-md:top-full max-md:bottom-auto max-md:mt-2 max-md:mb-0 max-md:right-0 max-md:left-auto"
				>
					<div className="flex items-center gap-2 border-b border-line px-3 py-2">
						<h2 className="mr-auto text-sm font-semibold">
							{t("notif.title")}
						</h2>
						<button
							type="button"
							disabled={unread === 0 || read.isPending}
							onClick={() => read.mutate({ all: true })}
							className="rounded-chip text-xs text-ai-indigo underline disabled:text-nezumi disabled:no-underline pointer-coarse:min-h-11"
						>
							{t("notif.readAll")}
						</button>
					</div>
					{data?.items.length ? (
						<ul className="max-h-96 overflow-auto py-1">
							{data.items.map((n) => (
								<li key={n.id}>
									<button
										type="button"
										onClick={() => {
											setOpen(false);
											if (!n.readAt) read.mutate({ ids: [n.id] });
											nav({
												to: "/p/$key",
												params: { key: projectOf(n.ref) },
												search: { issue: n.ref },
											});
										}}
										className="flex w-full gap-2 px-3 py-2 text-left hover:bg-row-hover pointer-coarse:min-h-11"
									>
										<span
											aria-hidden
											className={cx(
												"mt-1.5 h-2 w-2 shrink-0 rounded-full",
												n.readAt ? "bg-transparent" : "bg-sash",
											)}
										/>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm">
												<span className="num mr-1.5 font-medium text-nezumi">
													{n.ref}
												</span>
												<span className={cx(!n.readAt && "font-medium")}>
													{n.title}
												</span>
											</span>
											<span className="block text-xs text-nezumi">
												{t(`notif.${n.kind}`)}
												{!n.readAt && (
													<span className="sr-only">
														（{t("notif.unread", { n: 1 })}）
													</span>
												)}
												<span aria-hidden> ・ </span>
												{relativeTime(n.createdAt)}
											</span>
										</span>
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="px-3 py-6 text-sm text-nezumi">{t("notif.empty")}</p>
					)}
				</div>
			)}
		</div>
	);
}
