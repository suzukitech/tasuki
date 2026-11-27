import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";
import { t } from "../i18n";
import { TURN_KEY, type Turn } from "../lib/turn";

export const cx = (...c: (string | false | undefined | null)[]) =>
	c.filter(Boolean).join(" ");

export const inputCls =
	"w-full rounded border border-line bg-surface px-2 py-1.5 text-base text-ink placeholder:text-nezumi";

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	kind?: "primary" | "plain" | "danger";
};
export function Button({ kind = "plain", className, ...p }: BtnProps) {
	return (
		<button
			type="button"
			{...p}
			className={cx(
				"rounded px-3 py-1.5 text-base font-bold disabled:opacity-50",
				kind === "primary" && "bg-ai-indigo text-white",
				kind === "plain" && "border border-line bg-surface text-ink",
				kind === "danger" && "border border-sash bg-surface text-sash",
				className,
			)}
		/>
	);
}

/** 「あなたの番」 carries the sash; AI is asagi; everyone else is quiet. */
export function TurnBadge({ turn }: { turn: Turn | null }) {
	if (!turn) return null;
	return (
		<span
			className={cx(
				"inline-block whitespace-nowrap rounded-sm px-2 text-sm",
				turn === "you" && "sash border border-sash font-bold text-sash",
				turn === "ai" && "border border-asagi text-asagi",
				turn === "others" && "border border-line text-nezumi",
			)}
		>
			{t(TURN_KEY[turn])}
		</span>
	);
}

type Toast = { id: number; text: string };
const ToastCtx = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
	const [items, setItems] = useState<Toast[]>([]);
	const push = useCallback((text: string) => {
		const id = Date.now() + Math.random();
		setItems((x) => [...x, { id, text }]);
		setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 6000);
	}, []);
	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div
				role="status"
				aria-live="polite"
				className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2"
			>
				{items.map((i) => (
					<div
						key={i.id}
						className="flex items-center gap-3 rounded bg-ink px-4 py-2 text-base text-white"
					>
						{i.text}
						<button
							type="button"
							aria-label={t("toast.close")}
							className="text-white"
							onClick={() => setItems((x) => x.filter((y) => y.id !== i.id))}
						>
							×
						</button>
					</div>
				))}
			</div>
		</ToastCtx.Provider>
	);
}
