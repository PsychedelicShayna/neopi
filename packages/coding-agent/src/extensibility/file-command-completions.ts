import type { SlashCommand } from "@oh-my-pi/pi-tui";
import { sanitizeDisplayText } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { FileSlashCommand } from "./slash-commands";

/** The same board and Active-column order used by the Deck /pick-task template. */
async function listActiveDeckTasks(): Promise<{ id: string; title: string; order: number }[]> {
	const base =
		process.env.NPI_DECK_API_BASE?.trim() || `http://127.0.0.1:${process.env.NPI_DECK_PORT?.trim() || 1701}`;
	try {
		const endpoint = new URL(`${base.replace(/\/+$/, "")}/api/tasks`);
		if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return [];
		const response = await fetch(endpoint, {
			signal: AbortSignal.timeout(750),
			redirect: "error",
		});
		if (!response.ok) return [];
		const data: unknown = await response.json();
		if (!isRecord(data) || !Array.isArray(data.states) || !Array.isArray(data.tasks)) return [];
		const active = data.states.find(
			(state: unknown) => isRecord(state) && typeof state.name === "string" && state.name.toLowerCase() === "active",
		);
		if (!isRecord(active) || typeof active.id !== "string") return [];
		const tasks: { id: string; title: string; order: number }[] = [];
		for (const task of data.tasks) {
			if (
				isRecord(task) &&
				task.stateId === active.id &&
				!task.archivedAt &&
				typeof task.id === "string" &&
				/^t_[a-z0-9]+$/.test(task.id) &&
				typeof task.title === "string" &&
				typeof task.orderInState === "number"
			) {
				tasks.push({ id: task.id, title: task.title, order: task.orderInState });
			}
		}
		return tasks.sort((a, b) => a.order - b.order);
	} catch {
		// A standalone TUI may not have Deck running. The keyword still works as an argument.
		return [];
	}
}

/** File-command hints are prose. Only explicitly opted-in sources provide values. */
export function buildFileSlashArgumentCompletions(command: FileSlashCommand): SlashCommand["getArgumentCompletions"] {
	if (command.argumentCompletions !== "deck-active-tasks") return undefined;
	return async prefix => {
		const query = prefix.trim().toLowerCase();
		const tasks = await listActiveDeckTasks();
		const items = tasks
			.filter(task => task.id.startsWith(query) || task.title.toLowerCase().includes(query))
			.map(task => ({
				value: task.id,
				label: task.id,
				description: sanitizeDisplayText(task.title).replace(/[\r\n]+/g, " "),
			}));
		if ("top".startsWith(query)) {
			items.unshift({ value: "top", label: "top", description: "Highest-priority active task" });
		}
		if (items.length === 0) return null;
		return query ? items : items.map(item => ({ ...item, preserveInputOnSubmit: true }));
	};
}
