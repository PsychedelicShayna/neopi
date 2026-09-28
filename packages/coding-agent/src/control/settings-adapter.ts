/**
 * Session-bound settings reads and writes for the control socket (#171).
 *
 * Address is a registered id, plus an optional record member (`modelRoles` +
 * `default`, `tools.approval` + `bash`). Approval-weakening paths are refused
 * by the host before this adapter commits.
 */
import { lookup, type AnySetting } from "../config/registry";
import type { Settings } from "../config/settings";

export interface SettingsWrite {
	path: string;
	member?: string;
	value?: unknown;
	runtime?: boolean;
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

export function writeSetting(settings: Settings, write: SettingsWrite): { path: string; value: unknown } {
	const setting = lookup(write.path);
	if (!setting) throw new Error(`unknown setting ${write.path}`);
	if (write.member) {
		writeMember(settings, setting, write.member, write.value, write.runtime === true);
	} else if (write.runtime) {
		setting.override(settings, write.value as never);
	} else if (write.value === undefined) {
		setting.unset(settings);
	} else {
		setting.set(settings, write.value as never);
	}
	return { path: write.path, value: readSetting(settings, write.path, write.member) };
}

function writeMember(settings: Settings, setting: AnySetting, member: string, value: unknown, runtime: boolean): void {
	if (setting.id === "modelRoles" && "setModelRole" in settings) {
		(settings as Settings).setModelRole(member, value === undefined ? undefined : String(value));
		return;
	}
	const current = setting.get(settings);
	const record = isRecord(current) ? { ...current } : {};
	if (value === undefined) delete record[member];
	else record[member] = value;
	if (runtime) setting.override(settings, record as never);
	else setting.set(settings, record as never);
}

export function unsetSetting(settings: Settings, path: string, member?: string): void {
	if (member) writeSetting(settings, { path, member, value: undefined });
	else {
		const setting = lookup(path);
		if (!setting) throw new Error(`unknown setting ${path}`);
		setting.unset(settings);
	}
}
