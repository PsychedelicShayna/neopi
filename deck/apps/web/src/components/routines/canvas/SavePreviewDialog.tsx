/** Optional source-change review, shown only while deliberately editing source. */

import { useEffect, useMemo, useRef } from "react";
import { Save, X } from "lucide-react";

import { diffIsClean, lineDiff, type DiffLine } from "./toml-diff";

interface SavePreviewDialogProps {
	/** TOML currently persisted on the routine (empty string for a new routine). */
	currentToml: string;
	/** Compiled TOML that will be PATCHed to the API if the user confirms. */
	newToml: string;
	/** Commit via `routinesApi.update/create`. The dialog renders its own busy state. */
	onConfirm: () => void | Promise<void>;
	/** Close without saving. */
	onCancel: () => void;
	/** Disables the Save button + shows a busy indicator while the request is in flight. */
	busy?: boolean;
}

export function SavePreviewDialog({
	currentToml,
	newToml,
	onConfirm,
	onCancel,
	busy,
}: SavePreviewDialogProps): JSX.Element {
	const diff = useMemo(() => lineDiff(currentToml, newToml), [currentToml, newToml]);
	const clean = diffIsClean(diff);

	const addCount = diff.reduce((n, l) => (l.kind === "add" ? n + 1 : n), 0);
	const delCount = diff.reduce((n, l) => (l.kind === "del" ? n + 1 : n), 0);

	// Esc cancels. Same convention as StepInspector.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape" && !busy) onCancel();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onCancel, busy]);

	// Pull initial focus to the Save button so Enter commits without an extra
	// click after the dialog opens.
	const saveBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		saveBtnRef.current?.focus();
	}, []);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Confirm routine save"
			data-testid="save-preview-dialog"
			className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 px-4"
		>
			<div className="flex max-h-[90vh] w-[min(820px,100%)] flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-xl">
				<header className="flex items-center gap-2 border-b border-line bg-paper-2/60 px-3 py-2">
					<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">Source changes</span>
					<span className="font-mono text-2xs text-ink-3">
						{clean ? (
							<span className="text-ink-4">no changes</span>
						) : (
							<>
								<span className="text-success">+{addCount}</span>{" "}
								<span className="text-danger">-{delCount}</span>
							</>
						)}
					</span>
					<button
						type="button"
						onClick={() => {
							if (!busy) onCancel();
						}}
						className="btn-ghost ml-auto h-7 w-7 p-0 text-ink-3 hover:text-ink"
						aria-label="Close"
						title="Close (Esc)"
						disabled={busy}
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</header>

				<div className="flex-1 overflow-auto bg-paper-code px-2 py-2">
					{clean ? (
						<div className="rounded border border-dashed border-line bg-paper-2 px-3 py-6 text-center font-mono text-2xs text-ink-3">
							The compiled TOML matches the currently-saved spec. Nothing to commit.
						</div>
					) : (
						<pre className="font-mono text-2xs leading-snug">
							<code>
								{diff.map((line, idx) => (
									<DiffLineRow key={idx} line={line} />
								))}
							</code>
						</pre>
					)}
				</div>

				<footer className="flex items-center gap-2 border-t border-line bg-paper-2/60 px-3 py-2">
					<span className="font-mono text-2xs text-ink-3">Review source changes before saving.</span>
					<div className="ml-auto flex items-center gap-1.5">
						<button type="button" onClick={onCancel} className="btn-ghost h-7 text-2xs" disabled={busy}>
							Edit canvas
						</button>
						<button
							ref={saveBtnRef}
							type="button"
							onClick={() => void onConfirm()}
							className="btn-primary h-7 text-2xs disabled:opacity-50"
							disabled={busy || clean}
							aria-label="Save routine"
						>
							<Save className="h-3.5 w-3.5" />
							{busy ? "Saving…" : "Save"}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}

function DiffLineRow({ line }: { line: DiffLine }): JSX.Element {
	const cls =
		line.kind === "add"
			? "block bg-success/10 text-success"
			: line.kind === "del"
				? "block bg-danger/10 text-danger"
				: "block text-ink-2";
	const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
	// Render an empty space for blank lines so the gutter stays aligned.
	const body = line.text === "" ? " " : line.text;
	return (
		<span className={cls}>
			<span className="select-none pr-2 text-ink-4">{marker}</span>
			{body}
			{"\n"}
		</span>
	);
}

/**
 * Pure helper extracted for testing. Returns true when the parent should
 * bypass the dialog. Reads:
 *  - `import.meta.env.NPI_DECK_CANVAS_SKIP_PREVIEW` (vite build-time, requires
 *    the `envPrefix` to include `NPI_DECK_`)
 *  - `localStorage["npi-deck:canvas-skip-preview"]` (runtime opt-out)
 *
 * Either value of "1" skips the preview.
 */
export function shouldSkipSavePreview(): boolean {
	try {
		// Vite injects `import.meta.env` at build time. Cast through unknown to
		// keep this file dependency-free of the vite types module.
		const envRaw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
		if (envRaw?.NPI_DECK_CANVAS_SKIP_PREVIEW === "1") return true;
	} catch {
		// Build-time env unavailable (test runtime); fall through.
	}
	try {
		if (typeof localStorage !== "undefined") {
			if (localStorage.getItem("npi-deck:canvas-skip-preview") === "1") return true;
		}
	} catch {
		// localStorage can throw in private-browsing or SSR; ignore.
	}
	return false;
}
