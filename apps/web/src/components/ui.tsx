import type { Category } from "@tasuki/schema/pure";
import {
	Check,
	CircleAlert,
	Info,
	type LucideIcon,
	UserRound,
	X,
} from "lucide-react";
import {
	createContext,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { hueOf, initialOf } from "../lib/format";
import { PRIORITY_KEYS } from "../lib/priority";
import { TURN_KEY, type Turn } from "../lib/turn";
import type { Member } from "../lib/types";

export const cx = (...c: (string | false | undefined | null)[]) =>
	c.filter(Boolean).join(" ");

export const inputCls =
	"w-full rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-nezumi pointer-coarse:min-h-11";

/** 16px / stroke 1.75 everywhere (docs/DESIGN.md). */
export const iconProps = {
	size: 16,
	strokeWidth: 1.75,
	"aria-hidden": true,
} as const;

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	kind?: "primary" | "plain" | "danger";
};
export function Button({ kind = "plain", className, ...p }: BtnProps) {
	return (
		<button
			type="button"
			{...p}
			className={cx(
				"inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 text-sm font-medium disabled:opacity-50 pointer-coarse:h-11",
				kind === "primary" &&
					"bg-ai-indigo text-white enabled:hover:bg-indigo-deep",
				kind === "plain" &&
					"border border-line-strong bg-surface text-ink enabled:hover:bg-row-hover",
				kind === "danger" &&
					"border border-sash/50 bg-surface text-sash enabled:hover:bg-sash-tint",
				className,
			)}
		/>
	);
}

export function IconButton({
	icon: Icon,
	label,
	className,
	...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
	icon: LucideIcon;
	label: string;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			{...p}
			className={cx(
				"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-nezumi hover:bg-row-hover hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11",
				className,
			)}
		>
			<Icon {...iconProps} />
		</button>
	);
}

/** Panel body text: 15px / 1.75, about 68 columns wide. */
export const Text = ({
	children,
	className,
}: {
	children: string;
	className?: string;
}) => (
	<p
		className={cx(
			"max-w-[68ch] whitespace-pre-wrap text-base leading-[1.75]",
			className,
		)}
	>
		{children}
	</p>
);

/** Shortcut hint. Hidden on narrow screens and touch (no keyboard there). */
export const Kbd = ({ children }: { children: ReactNode }) => (
	<kbd className="max-md:hidden pointer-coarse:hidden">{children}</kbd>
);

/** Small tag. tone: quiet (default), ai (via tags) or sash (needs a human). */
export function Chip({
	children,
	className,
	tone,
}: {
	children: ReactNode;
	className?: string;
	tone?: "ai" | "sash";
}) {
	return (
		<span
			className={cx(
				"inline-flex items-center whitespace-nowrap rounded-chip border px-1.5 text-xs leading-5",
				tone === "ai" && "border-transparent bg-paper text-asagi",
				tone === "sash" && "border-sash/40 font-medium text-sash",
				!tone && "border-line-strong text-nezumi",
				className,
			)}
		>
			{children}
		</span>
	);
}

export function Avatar({
	id,
	name,
	size = 20,
}: {
	id: string;
	name: string;
	size?: number;
}) {
	const h = hueOf(id);
	return (
		<span
			aria-hidden
			className="inline-flex shrink-0 items-center justify-center rounded-full font-medium"
			style={{
				width: size,
				height: size,
				fontSize: Math.round(size * 0.5),
				background: `hsl(${h} 28% 90%)`,
				color: `hsl(${h} 38% 30%)`,
			}}
		>
			{initialOf(name)}
		</span>
	);
}

const DOT: Record<Category, string> = {
	draft: "bg-nezumi",
	ready: "bg-indigo-light",
	plan_review: "bg-sash",
	impl_review: "bg-sash",
	in_progress: "bg-asagi",
	done: "bg-done",
};
export const StatusDot = ({ category }: { category: Category }) => (
	<span
		aria-hidden
		className={cx("inline-block size-2 shrink-0 rounded-full", DOT[category])}
	/>
);

/** Three-bar signal. none = empty bars, urgent = full bars in the sash colour. */
export function PriorityGlyph({
	level,
	label,
}: {
	level: number;
	label: string;
}) {
	const lit = Math.min(level, 3);
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className="inline-flex h-3.5 items-end gap-0.5"
		>
			{[6, 10, 14].map((h, i) => (
				<span
					key={h}
					style={{ height: h }}
					className={cx(
						"w-[3px] rounded-[1px]",
						i < lit ? (level >= 4 ? "bg-sash" : "bg-nezumi") : "bg-line-strong",
					)}
				/>
			))}
		</span>
	);
}

/** 「あなたの番」 carries the sash; AI is asagi; everyone else is quiet. */
export function TurnBadge({ turn }: { turn: Turn | null }) {
	if (!turn) return null;
	return (
		<span
			className={cx(
				"inline-block whitespace-nowrap rounded-chip border px-2 text-xs leading-5",
				turn === "you" && "sash border-sash font-semibold text-sash",
				turn === "ai" && "border-asagi/60 text-asagi",
				turn === "others" && "border-line-strong text-nezumi",
			)}
		>
			{t(TURN_KEY[turn])}
		</span>
	);
}

/** Small two-or-more way switch (aria-pressed buttons). ≥44px tall on touch. */
export function Segmented<V extends string | boolean>(p: {
	value: V;
	onChange: (v: V) => void;
	label: string;
	options: readonly { value: V; label: string; icon?: LucideIcon }[];
	className?: string;
}) {
	return (
		<fieldset
			className={cx(
				"m-0 flex w-fit min-w-0 rounded-control border-0 bg-paper p-0.5",
				p.className,
			)}
		>
			<legend className="sr-only">{p.label}</legend>
			{p.options.map((o) => (
				<button
					key={String(o.value)}
					type="button"
					aria-pressed={p.value === o.value}
					onClick={() => p.onChange(o.value)}
					className={cx(
						"inline-flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs leading-6 whitespace-nowrap pointer-coarse:min-h-11",
						p.value === o.value
							? "bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--line-strong)]"
							: "text-nezumi hover:text-ink",
					)}
				>
					{o.icon && <o.icon {...iconProps} />}
					{o.label}
				</button>
			))}
		</fieldset>
	);
}

/** 「AIに任せる / 人がやる」: flow = ai (true) or simple (false). */
export const FlowToggle = (p: {
	value: boolean;
	onChange: (ai: boolean) => void;
	label: string;
	className?: string;
}) => (
	<Segmented
		{...p}
		options={[
			{ value: true, label: t("list.create.ai") },
			{ value: false, label: t("list.create.human") },
		]}
	/>
);

export function EmptyState({
	icon: Icon,
	children,
	action,
}: {
	icon: LucideIcon;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-start gap-3 py-10 text-nezumi">
			<Icon size={20} strokeWidth={1.75} aria-hidden />
			<p className="max-w-[44ch] text-sm leading-relaxed">{children}</p>
			{action}
		</div>
	);
}

export function Skeleton({ className }: { className?: string }) {
	return <div aria-hidden className={cx("skeleton rounded-chip", className)} />;
}

export type MenuOption = { value: string; label: string; icon?: ReactNode };

export const NoAvatar = () => (
	<span
		aria-hidden
		className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-nezumi"
	>
		<UserRound size={12} strokeWidth={1.75} />
	</span>
);

/** 未割り当て + every member (value "" = nobody). */
export const memberOptions = (members: Member[]): MenuOption[] => [
	{ value: "", label: t("assignee.none"), icon: <NoAvatar /> },
	...members.map((m) => ({
		value: m.id,
		label: m.name,
		icon: <Avatar id={m.id} name={m.name} />,
	})),
];

export const priorityOptions = (): MenuOption[] =>
	PRIORITY_KEYS.map((k, i) => ({
		value: String(i),
		label: t(k),
		icon: <PriorityGlyph level={i} label="" />,
	}));

/**
 * Button + listbox popover (replaces a native <select>). Arrow keys / Home / End move,
 * Enter or Space picks, Esc and Tab close, and focus returns to the button.
 */
export function Menu(p: {
	label: string;
	value: string;
	options: MenuOption[];
	onChange: (v: string) => void;
	children?: ReactNode;
	className?: string;
}) {
	const id = useId();
	const btn = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<React.CSSProperties | null>(null);
	const [active, setActive] = useState(0);
	const current = p.options.find((o) => o.value === p.value);
	const close = useCallback((refocus = true) => {
		setPos(null);
		if (refocus) btn.current?.focus();
	}, []);
	const open = () => {
		const r = btn.current?.getBoundingClientRect();
		if (!r || p.options.length === 0) return;
		const h = Math.min(p.options.length * 32 + 8, 280);
		const up = r.bottom + h + 8 > window.innerHeight && r.top > h;
		setActive(
			Math.max(
				0,
				p.options.findIndex((o) => o.value === p.value),
			),
		);
		setPos({
			left: Math.max(8, Math.min(r.left, window.innerWidth - 232)),
			minWidth: Math.max(r.width, 160),
			...(up
				? { bottom: window.innerHeight - r.top + 4 }
				: { top: r.bottom + 4 }),
		});
	};
	const isOpen = pos !== null;
	useEffect(() => {
		if (!isOpen) return;
		list.current?.focus({ preventScroll: true });
		const eatClick = (e: Event) => {
			e.stopPropagation();
			e.preventDefault();
		};
		const away = (e: Event) => {
			const n = e.target as Node;
			if (list.current?.contains(n) || btn.current?.contains(n)) return;
			close(false);
			// the click that dismisses must not also activate what is underneath
			document.addEventListener("click", eatClick, {
				capture: true,
				once: true,
			});
			setTimeout(
				() => document.removeEventListener("click", eatClick, true),
				500,
			);
		};
		const scrolled = (e: Event) => {
			if (!list.current?.contains(e.target as Node)) close(false);
		};
		document.addEventListener("pointerdown", away);
		window.addEventListener("scroll", scrolled, true);
		const resized = () => close(false);
		window.addEventListener("resize", resized);
		return () => {
			document.removeEventListener("pointerdown", away);
			window.removeEventListener("scroll", scrolled, true);
			window.removeEventListener("resize", resized);
		};
	}, [isOpen, close]);
	const pick = (v: string) => {
		close();
		if (v !== p.value) p.onChange(v);
	};
	const onKey = (e: KeyboardEvent) => {
		const n = p.options.length;
		if (n === 0) return close();
		// the menu owns every key it can see: none may reach the page shortcuts
		e.stopPropagation();
		const go = (i: number) => {
			e.preventDefault();
			setActive((i + n) % n);
		};
		if (e.key === "ArrowDown") go(active + 1);
		else if (e.key === "ArrowUp") go(active - 1);
		else if (e.key === "Home") go(0);
		else if (e.key === "End") go(n - 1);
		else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			pick(p.options[active]?.value ?? p.value);
		} else if (e.key === "Escape") {
			e.preventDefault();
			close();
		} else if (e.key === "Tab") close(false);
		else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
			// type-ahead: next option whose label starts with the typed letter
			const c = e.key.toLowerCase();
			for (let k = 1; k <= n; k++) {
				const i = (active + k) % n;
				if (p.options[i]?.label.toLowerCase().startsWith(c)) return go(i);
			}
		}
	};
	return (
		<>
			<button
				ref={btn}
				type="button"
				aria-haspopup="listbox"
				aria-expanded={isOpen}
				aria-label={`${p.label}: ${current?.label ?? ""}`}
				onClick={() => (isOpen ? close() : open())}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" && !isOpen) {
						e.preventDefault();
						open();
					}
				}}
				className={cx(
					"inline-flex max-w-full items-center gap-2 rounded-control text-left hover:bg-row-hover pointer-coarse:min-h-11",
					p.className,
				)}
			>
				{p.children ?? current?.label}
			</button>
			{pos &&
				createPortal(
					<div
						ref={list}
						role="listbox"
						tabIndex={-1}
						aria-label={p.label}
						aria-activedescendant={`${id}-${active}`}
						onKeyDown={onKey}
						style={pos}
						className="pop fixed z-50 max-h-72 overflow-auto rounded-panel border border-line bg-surface p-1 shadow-float outline-none"
					>
						{p.options.map((o, i) => (
							// biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the listbox (activedescendant)
							<div
								key={o.value}
								id={`${id}-${i}`}
								role="option"
								aria-selected={o.value === p.value}
								tabIndex={-1}
								onPointerEnter={() => setActive(i)}
								onClick={() => pick(o.value)}
								className={cx(
									"flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-sm pointer-coarse:min-h-11",
									i === active && "bg-selection",
								)}
							>
								{o.icon}
								<span className="flex-1">{o.label}</span>
								{o.value === p.value && (
									<Check {...iconProps} className="text-ai-indigo" />
								)}
							</div>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}

type Kind = "error" | "info" | "success";
type Toast = { id: number; text: string; kind: Kind };
const ToastCtx = createContext<(text: string, kind?: Kind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
const KIND_ICON: Record<Kind, [LucideIcon, string]> = {
	error: [CircleAlert, "text-sash"],
	info: [Info, "text-ai-indigo"],
	success: [Check, "text-done"],
};
const TOAST_MS = 5000;

function ToastItem({ item, done }: { item: Toast; done: () => void }) {
	const [hover, setHover] = useState(false);
	const left = useRef(TOAST_MS);
	useEffect(() => {
		if (hover) return;
		const start = Date.now();
		const timer = setTimeout(done, left.current);
		return () => {
			clearTimeout(timer);
			left.current -= Date.now() - start;
		};
	}, [hover, done]);
	const [Icon, color] = KIND_ICON[item.kind];
	return (
		<div
			onPointerEnter={() => setHover(true)}
			onPointerLeave={() => setHover(false)}
			className="toast pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-panel border border-line bg-surface py-2.5 pr-1.5 pl-3 text-sm shadow-float"
		>
			<Icon {...iconProps} className={cx("mt-0.5 shrink-0", color)} />
			<span className="flex-1">{item.text}</span>
			<IconButton
				icon={X}
				label={t("toast.close")}
				className="-my-1"
				onClick={done}
			/>
		</div>
	);
}

export function ToastProvider({ children }: { children: ReactNode }) {
	const [items, setItems] = useState<Toast[]>([]);
	const push = useCallback((text: string, kind: Kind = "error") => {
		const id = Date.now() + Math.random();
		setItems((x) => [...x, { id, text, kind }]);
	}, []);
	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div
				role="status"
				aria-live="polite"
				className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2 md:left-[calc(14rem+1rem)]"
			>
				{items.map((i) => (
					<ToastItem
						key={i.id}
						item={i}
						done={() => setItems((x) => x.filter((y) => y.id !== i.id))}
					/>
				))}
			</div>
		</ToastCtx.Provider>
	);
}
