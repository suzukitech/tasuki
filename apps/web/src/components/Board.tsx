import {
	closestCorners,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	useDndContext,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type KeyboardEvent, memo, useMemo, useState } from "react";
import { t } from "../i18n";
import { colId, colOfOver, columnsOf, planDrop } from "../lib/board";
import { relativeDue } from "../lib/format";
import { PRIORITY_KEYS } from "../lib/priority";
import { turnOf } from "../lib/turn";
import type { IssueRow, Me, ProjectDetail, Status } from "../lib/types";
import {
	Avatar,
	cx,
	NoAvatar,
	PriorityGlyph,
	StatusDot,
	TurnBadge,
} from "./ui";

const GATES = new Set(["plan_review", "impl_review"]);

function CardBody(p: { row: IssueRow; project: ProjectDetail; me: Me }) {
	const { row, project } = p;
	const assignee = project.members.find((m) => m.id === row.assigneeId);
	const due = row.dueDate ? relativeDue(row.dueDate) : null;
	const priority = row.priority ?? 0;
	return (
		<>
			<div className="flex items-center justify-between gap-2">
				<span className="num text-xs font-medium text-nezumi">{row.ref}</span>
				<TurnBadge turn={turnOf(row, project.statuses, p.me.id)} />
			</div>
			<p className="mt-1 line-clamp-3 text-sm font-medium break-words text-ink">
				{row.title}
			</p>
			<div className="mt-2 flex min-h-5 items-center gap-2.5">
				<PriorityGlyph
					level={priority}
					label={t(PRIORITY_KEYS[priority] ?? "priority.none")}
				/>
				{due && (
					<span
						className={cx(
							"num text-xs",
							due.late ? "font-medium text-sash" : "text-nezumi",
						)}
					>
						{due.text}
					</span>
				)}
				<span className="ml-auto">
					{assignee ? (
						<span title={assignee.name}>
							<Avatar id={assignee.id} name={assignee.name} />
							<span className="sr-only">{assignee.name}</span>
						</span>
					) : (
						<NoAvatar />
					)}
				</span>
			</div>
		</>
	);
}

const CARD = "rounded-control border border-line bg-surface p-2.5 text-left";

const Card = memo(function Card(p: {
	row: IssueRow;
	project: ProjectDetail;
	me: Me;
	open: boolean;
	onOpen: (ref: string) => void;
}) {
	const s = useSortable({
		id: p.row.id,
		data: { statusId: p.row.statusId },
		attributes: { roleDescription: t("board.card.role") },
	});
	const keys = s.listeners as
		| { onKeyDown?: (e: KeyboardEvent) => void }
		| undefined;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit adds role=button and tabIndex to this node; keys are handled below
		<div
			ref={s.setNodeRef}
			{...s.attributes}
			{...s.listeners}
			style={{
				transform: CSS.Translate.toString(s.transform),
				transition: s.transition,
			}}
			onClick={() => p.onOpen(p.row.ref)}
			onKeyDown={(e) => {
				// Enter opens (the keyboard sensor takes Space); the page's own Enter shortcut must not also fire
				if (e.key === "Enter" && !e.nativeEvent.isComposing) {
					e.preventDefault();
					e.stopPropagation();
					p.onOpen(p.row.ref);
				} else keys?.onKeyDown?.(e);
			}}
			className={cx(
				CARD,
				"cursor-grab touch-manipulation hover:bg-row-hover pointer-coarse:min-h-11",
				p.open && "border-ai-indigo bg-selection",
				s.isDragging && "opacity-40",
			)}
		>
			<CardBody row={p.row} project={p.project} me={p.me} />
		</div>
	);
});

function Column(p: {
	status: Status;
	rows: IssueRow[];
	project: ProjectDetail;
	me: Me;
	openRef?: string;
	onOpen: (ref: string) => void;
}) {
	const drop = useDroppable({ id: colId(p.status.id) });
	// highlighted while the pointer is over the column or any card in it
	const over = useDndContext().over?.id;
	const isOver =
		over !== undefined &&
		(over === colId(p.status.id) || p.rows.some((r) => r.id === over));
	const gate = GATES.has(p.status.category);
	return (
		<section
			aria-label={p.status.name}
			className={cx(
				"flex w-72 shrink-0 flex-col rounded-panel border bg-paper max-md:w-[78vw]",
				isOver ? "border-ai-indigo bg-selection" : "border-line",
			)}
		>
			<header
				className={cx(
					"flex items-center gap-2 border-b border-line px-3 py-2",
					gate && "sash overflow-hidden rounded-t-panel",
				)}
			>
				<StatusDot category={p.status.category} />
				<h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
					{p.status.name}
				</h2>
				<span className="num text-xs text-nezumi">
					<span aria-hidden>{p.rows.length}</span>
					<span className="sr-only">
						{t("board.count", { n: p.rows.length })}
					</span>
				</span>
			</header>
			<SortableContext
				items={p.rows.map((r) => r.id)}
				strategy={verticalListSortingStrategy}
			>
				<div
					ref={drop.setNodeRef}
					className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2"
				>
					{p.rows.map((r) => (
						<Card
							key={r.id}
							row={r}
							project={p.project}
							me={p.me}
							open={r.ref === p.openRef}
							onOpen={p.onOpen}
						/>
					))}
					{p.rows.length === 0 && (
						<p className="px-1 py-3 text-xs text-nezumi">{t("board.empty")}</p>
					)}
				</div>
			</SortableContext>
		</section>
	);
}

/** Status columns of cards in rank order. Dropping sends status + rank; the server decides whether the move is allowed. */
export function Board(p: {
	project: ProjectDetail;
	me: Me;
	rows: IssueRow[];
	openRef?: string;
	onOpen: (ref: string) => void;
	onMove: (
		row: IssueRow,
		to: { statusId: string; rank?: string; appended?: true },
	) => void;
	/** columns are partial (still loading): cards stay put so ranks are never computed against half a column */
	locked?: boolean;
	/** true while a drag is in progress (Escape then cancels the drag, not the panel) */
	onDragging?: (on: boolean) => void;
}) {
	const cols = useMemo(
		() => columnsOf(p.project.statuses, p.rows),
		[p.project.statuses, p.rows],
	);
	const [dragId, setDragId] = useState<string | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
			// Space lifts and drops; Enter is left to "open"
			keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
		}),
	);
	const byId = useMemo(() => new Map(p.rows.map((r) => [r.id, r])), [p.rows]);
	const nameOf = (id: unknown) => {
		const row = byId.get(String(id));
		return row ? `${row.ref} ${row.title}` : "";
	};
	const colNameOf = (overId: unknown) =>
		colOfOver(cols, overId)?.[0].name ?? "";
	// Escape ends a drag before the page's own key handler runs: keep "dragging" up for this event
	const stop = () => {
		setDragId(null);
		setTimeout(() => p.onDragging?.(false), 0);
	};
	const end = (e: DragEndEvent) => {
		stop();
		if (!e.over) return;
		const to = planDrop(cols, String(e.active.id), String(e.over.id));
		const row = byId.get(String(e.active.id));
		if (to && row) p.onMove(row, to);
	};
	const dragging = dragId ? byId.get(dragId) : undefined;
	return (
		<DndContext
			sensors={p.locked ? [] : sensors}
			collisionDetection={closestCorners}
			accessibility={{
				screenReaderInstructions: { draggable: t("board.dnd.help") },
				announcements: {
					onDragStart: ({ active }) =>
						t("board.dnd.start", { name: nameOf(active.id) }),
					onDragOver: ({ over }) =>
						over ? t("board.dnd.over", { col: colNameOf(over.id) }) : "",
					onDragEnd: ({ active, over }) =>
						over
							? t("board.dnd.end", {
									name: nameOf(active.id),
									col: colNameOf(over.id),
								})
							: t("board.dnd.cancel", { name: nameOf(active.id) }),
					onDragCancel: ({ active }) =>
						t("board.dnd.cancel", { name: nameOf(active.id) }),
				},
			}}
			onDragStart={(e) => {
				setDragId(String(e.active.id));
				p.onDragging?.(true);
			}}
			onDragEnd={end}
			onDragCancel={stop}
		>
			<div className="flex h-full gap-3">
				{cols.map(([status, list]) => (
					<Column
						key={status.id}
						status={status}
						rows={list}
						project={p.project}
						me={p.me}
						openRef={p.openRef}
						onOpen={p.onOpen}
					/>
				))}
			</div>
			<DragOverlay>
				{dragging && (
					<div className={cx(CARD, "cursor-grabbing shadow-float")}>
						<CardBody row={dragging} project={p.project} me={p.me} />
					</div>
				)}
			</DragOverlay>
		</DndContext>
	);
}
