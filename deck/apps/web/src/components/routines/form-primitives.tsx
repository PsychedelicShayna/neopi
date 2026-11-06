import { CircleAlert } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { NeoSelect } from "@/components/neo";

const FieldLabel = createContext<string | undefined>(undefined);

/**
 * A labelled control. Sentence-case label, optional `optional` tag, help text
 * under the control, and the validation message at the field itself: the
 * control turns red through `data-invalid` and the message sits beneath it.
 */
export function Field({
	label,
	optional,
	help,
	error,
	children,
}: {
	label: ReactNode;
	optional?: boolean;
	help?: ReactNode;
	error?: string;
	children: ReactNode;
}) {
	return (
		<div className="neo-field" data-invalid={error ? "true" : undefined}>
			<div className="neo-field-label">
				<span>{label}</span>
				{optional ? <small>optional</small> : null}
			</div>
			<FieldLabel.Provider value={typeof label === "string" ? label : undefined}>{children}</FieldLabel.Provider>
			{error ? (
				<div className="neo-field-error" role="alert">
					<CircleAlert size={12} />
					<span>{error}</span>
				</div>
			) : help !== undefined ? (
				<div className="neo-field-help">{help}</div>
			) : null}
		</div>
	);
}

export function TextInput({
	value,
	onChange,
	placeholder,
	mono,
	ariaLabel,
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	mono?: boolean;
	ariaLabel?: string;
}) {
	return (
		<input
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			aria-label={ariaLabel}
			className="neo-input w-full"
			data-mono={mono || undefined}
		/>
	);
}

export function TextArea({
	value,
	onChange,
	placeholder,
	rows = 3,
	mono = true,
	ariaLabel,
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	rows?: number;
	mono?: boolean;
	ariaLabel?: string;
}) {
	return (
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			rows={rows}
			placeholder={placeholder}
			aria-label={ariaLabel}
			className="neo-input w-full"
			data-mono={mono || undefined}
		/>
	);
}

/** Expressions and card frontmatter belong to deliberate advanced editing. */
export function hasAdvancedContent(value: string): boolean {
	return value.includes("{{") || /^\+\+\+\r?\n/.test(value);
}

/** Never replace a stored expression with a basic-mode placeholder value. */
export function ActionTextField({
	label, value, onChange, advanced, placeholder, rows, mono, error, help, optional,
}: {
	label: string;
	value: string;
	onChange: (next: string) => void;
	advanced: boolean;
	placeholder?: string;
	rows?: number;
	mono?: boolean;
	error?: string;
	help?: ReactNode;
	optional?: boolean;
}) {
	return (
		<Field label={label} error={error} help={help} optional={optional}>
			{!advanced && hasAdvancedContent(value) ? (
				<div className="space-y-1.5">
					<pre className="neo-code-block max-h-40 !text-[12px]">{value}</pre>
					<AdvancedNotice>This field uses templates. Turn on Advanced to edit it.</AdvancedNotice>
				</div>
			) : rows !== undefined ? (
				<TextArea value={value} onChange={onChange} placeholder={placeholder} rows={rows} mono={mono} ariaLabel={label} />
			) : (
				<TextInput value={value} onChange={onChange} placeholder={placeholder} mono={mono} ariaLabel={label} />
			)}
		</Field>
	);
}

/** Quiet notice used wherever basic mode hides an advanced value. */
export function AdvancedNotice({ children }: { children: ReactNode }) {
	return (
		<p className="rounded-[var(--r-control)] border border-dashed border-[var(--neo-line-2)] px-2.5 py-2 text-[12px] leading-relaxed text-ink-3">
			{children}
		</p>
	);
}

export function NumInput({
	value,
	onChange,
	placeholder,
	ariaLabel,
}: {
	value: number | undefined;
	onChange: (next: number | undefined) => void;
	placeholder?: string;
	ariaLabel?: string;
}) {
	return (
		<input
			type="number"
			value={value ?? ""}
			onChange={(e) => {
				const raw = e.target.value;
				if (raw === "") onChange(undefined);
				else {
					const n = Number(raw);
					onChange(Number.isFinite(n) ? n : undefined);
				}
			}}
			placeholder={placeholder}
			aria-label={ariaLabel}
			className="neo-input w-full"
			data-mono="true"
		/>
	);
}

export function Select<T extends string>({
	value,
	onChange,
	options,
	ariaLabel,
}: {
	value: T;
	onChange: (next: T) => void;
	options: ReadonlyArray<{ value: T; label: string }>;
	ariaLabel?: string;
}) {
	const fieldLabel = useContext(FieldLabel);
	return (
		<NeoSelect
			value={value}
			onChange={(e) => onChange(e.target.value as T)}
			aria-label={ariaLabel ?? fieldLabel}
			className="neo-input w-full"
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</NeoSelect>
	);
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (next: boolean) => void; children: ReactNode }) {
	return (
		<label className="neo-check">
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
			<span>{children}</span>
		</label>
	);
}

export function TagInput({
	values,
	onChange,
	placeholder,
}: {
	values: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
}) {
	function remove(idx: number): void {
		const next = values.slice();
		next.splice(idx, 1);
		onChange(next);
	}
	function add(raw: string): void {
		const trimmed = raw.trim();
		if (!trimmed) return;
		if (values.includes(trimmed)) return;
		onChange([...values, trimmed]);
	}
	return (
		<div className="neo-input flex h-auto min-h-[30px] flex-wrap items-center gap-1 py-1 pl-1.5 pr-1.5">
			{values.map((v, idx) => (
				<span
					key={`${v}-${idx}`}
					className="inline-flex items-center gap-1 rounded-[var(--r-chip)] bg-[var(--neo-raised)] px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2"
				>
					{v}
					<button
						type="button"
						onClick={() => remove(idx)}
						className="text-ink-3 hover:text-danger"
						aria-label={`Remove ${v}`}
					>
						×
					</button>
				</span>
			))}
			<input
				placeholder={placeholder ?? "add…"}
				className="min-w-[8ch] flex-1 bg-transparent px-1 py-0 text-[12.5px] text-ink outline-none placeholder:text-ink-3"
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						add((e.target as HTMLInputElement).value);
						(e.target as HTMLInputElement).value = "";
					} else if (e.key === "Backspace" && (e.target as HTMLInputElement).value === "" && values.length > 0) {
						remove(values.length - 1);
					}
				}}
				onBlur={(e) => {
					add(e.target.value);
					e.target.value = "";
				}}
			/>
		</div>
	);
}

export function KeyValueEditor({
	pairs,
	onChange,
	keyPlaceholder,
	valuePlaceholder,
}: {
	pairs: Record<string, string>;
	onChange: (next: Record<string, string>) => void;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
}) {
	const entries = Object.entries(pairs);
	function setEntry(idx: number, key: string, value: string): void {
		const next = entries.slice();
		next[idx] = [key, value];
		onChange(toObj(next));
	}
	function add(): void {
		onChange(toObj([...entries, ["", ""]]));
	}
	function remove(idx: number): void {
		const next = entries.slice();
		next.splice(idx, 1);
		onChange(toObj(next));
	}
	return (
		<div className="space-y-1.5">
			{entries.map(([k, v], idx) => (
				<div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
					<input
						value={k}
						onChange={(e) => setEntry(idx, e.target.value, v)}
						placeholder={keyPlaceholder ?? "key"}
						className="neo-input w-full"
						data-size="sm"
						data-mono="true"
					/>
					<input
						value={v}
						onChange={(e) => setEntry(idx, k, e.target.value)}
						placeholder={valuePlaceholder ?? "value"}
						className="neo-input w-full"
						data-size="sm"
						data-mono="true"
					/>
					<button
						type="button"
						onClick={() => remove(idx)}
						className="neo-btn"
						data-variant="ghost"
						data-size="sm"
						data-icon="true"
						aria-label="Remove"
					>
						×
					</button>
				</div>
			))}
			<button type="button" onClick={add} className="neo-chip-btn">
				+ Add row
			</button>
		</div>
	);
}

function toObj(entries: Array<[string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of entries) {
		if (k.trim() !== "") out[k] = v;
	}
	return out;
}
