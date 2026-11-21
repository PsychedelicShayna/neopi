/**
 * The /statusline editor's unapplied draft, kept apart from config.yml so a
 * draft write can never change the active layout and a failed apply can never
 * lose the draft.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parseStatusLineEditorDraft, type StatusLineEditorDraft } from "@oh-my-pi/pi-tui/overlays/status-line-config";
import type { StatusLineSegmentOptions } from "@oh-my-pi/pi-tui/status-line/types";
import { JsonStateStore } from "./json-state";

export const STATUS_LINE_DRAFT_FILE = "neopi-statusline-draft.json";

export function validateStatusLineDraft(value: unknown): StatusLineEditorDraft | null {
	const draft = parseStatusLineEditorDraft(value);
	if (!draft) throw new Error(`Invalid schema-v1 ${STATUS_LINE_DRAFT_FILE}`);
	return draft;
}

export class StatusLineDraftStore extends JsonStateStore<StatusLineEditorDraft | null> {
	constructor(path: string | (() => string)) {
		super(path, "omomp-statusline-draft.json", validateStatusLineDraft, () => null);
	}

	/**
	 * Synchronous read for the editor's synchronous open path (slash command and
	 * menu-history reopen mount immediately). The file is one small JSON object.
	 */
	readSync(): StatusLineEditorDraft | null {
		let text: string;
		try {
			text = fs.readFileSync(this.path, "utf8");
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
		return validateStatusLineDraft(JSON.parse(text));
	}
}

export function statusLineDraftPath(agentDir: string): string {
	return nodePath.join(agentDir, STATUS_LINE_DRAFT_FILE);
}

/** Apply the template editor’s shared draft map to the corresponding segment settings. */
export function withUsageTemplates(
	options: StatusLineSegmentOptions | undefined,
	templates: Record<string, string>,
): StatusLineSegmentOptions {
	const { usageBars, liveMeter: _meter, ...rest } = options ?? {};
	const { live_meter: meterTemplate, ...usageTemplates } = templates;
	const { templates: _previous, ...barRest } = usageBars ?? {};
	const bars = Object.keys(usageTemplates).length > 0 ? { ...barRest, templates: usageTemplates } : barRest;
	return {
		...rest,
		...(Object.keys(bars).length ? { usageBars: bars } : {}),
		...(meterTemplate ? { liveMeter: { template: meterTemplate } } : {}),
	};
}
