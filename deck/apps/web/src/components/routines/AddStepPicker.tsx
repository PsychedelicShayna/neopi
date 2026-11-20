import { useState } from "react";
import { Plus } from "lucide-react";

import type { RoutineDeckAction, RoutineStep } from "@npi-deck/protocol";

import { STEP_TYPE_DESCRIPTIONS } from "./spec-toml";
import { actionLabel, STEP_ICON, stepIconTone } from "./step-form-render";

interface Props {
	onAdd: (type: RoutineStep["type"], presetAction?: RoutineDeckAction) => void;
}

export function AddStepPicker({ onAdd }: Props) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="neo-btn w-full justify-center border-dashed"
			>
				<Plus size={14} />
				Add step
			</button>
			{open ? (
				<div className="neo-card absolute z-10 mt-1.5 max-h-[60vh] w-full overflow-y-auto !shadow-[var(--neo-shadow-3)]">
					{STEP_TYPE_DESCRIPTIONS.map((t) => {
						const Icon = STEP_ICON[t.value];
						return (
							<button
								key={t.key}
								type="button"
								onClick={() => {
									onAdd(t.value, t.presetAction);
									setOpen(false);
								}}
								className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[var(--neo-hover)]"
							>
								<span className="neo-node-icon !h-[22px] !w-[22px]" data-tone={stepIconTone({ type: t.value })}><Icon size={12} /></span>
								<span className="min-w-0 flex-1">
									<span className="block text-[13px] text-ink">{actionLabel({ type: t.value, action: t.presetAction })}</span>
									<span className="block text-[11.5px] leading-snug text-ink-3">{t.help}</span>
								</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
