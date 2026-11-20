/**
 * Session-bound settings reads and writes for the control socket (#171).
 *
 * Address is a registered id, plus an optional record member (`modelRoles` +
 * `default`, `tools.approval` + `bash`). Approval-weakening paths are refused
 * by the host before this adapter commits.
 */
import { lookup, type AnySetting } from "../config/registry";
import type { Settings, SettingsScope } from "../config/settings";

interface SettingsWrite {
	scope: SettingsScope | "runtime";
	member?: string;
	value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSetting(settings: Settings, path: string, member?: string): unknown {
	const setting = lookup(path);
	if (!setting) return undefined;
	const value = setting.get(settings);
	if (!member) return value;
	return isRecord(value) ? value[member] : undefined;
}

/**
 * Applies one socket write to the addressed host. `conflict` means a global or project file edit was
 * refused because the file changed underneath it; nothing was written.
 */
export async function writeSetting(
	settings: Settings,
	setting: AnySetting,
	write: SettingsWrite,
): Promise<"applied" | "conflict"> {
	const { member, scope, value } = write;
	if (scope === "global" && member) {
		// Per-entry persistence: only this entry is merged into the re-read file, so a concurrent
		// edit to a sibling entry is kept. A model role's runtime override follows only once the
		// write was applied, so a refused write leaves the running model alone.
		if (setting.id === "modelRoles") {
			const receipt = await settings.persistModelRoleWithReceipt(
				member,
				value === undefined ? undefined : String(value),
			);
			return receipt.status;
		}
		const receipt = await settings.persistWithReceipt(() => setting.setEntry(settings, member, value as never));
		return receipt.status;
	}
	let next = value;
	if (member) {
		const current =
			scope === "runtime" ? settings.readRuntimeOverrideValue(setting) : settings.readScopeValue(setting, scope);
		const record = isRecord(current) ? current : {};
		if (value === undefined) {
			delete record[member];
			next = Object.keys(record).length === 0 ? undefined : record;
		} else {
			next = { ...record, [member]: value };
		}
	}
	if (scope === "runtime") {
		setting.override(settings, next);
		return "applied";
	}
	if (scope === "session") {
		settings.writeScopeValue(setting, next, scope);
		await settings.saveSessionSettings();
		return "applied";
	}
	const receipt = await settings.persistWithReceipt(() => settings.writeScopeValue(setting, next, scope));
	return receipt.status;
}
