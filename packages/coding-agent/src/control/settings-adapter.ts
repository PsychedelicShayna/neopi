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

export async function writeSetting(settings: Settings, setting: AnySetting, write: SettingsWrite): Promise<void> {
	const { member, scope, value } = write;
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
		return;
	}
	settings.writeScopeValue(setting, next, scope);
	if (scope === "session") await settings.saveSessionSettings();
	else await settings.flush();
}
