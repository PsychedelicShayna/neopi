import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RotateCcw, Save } from "lucide-react";
import type { NpiConfigPatchResponse, NpiConfigResponse, NpiConfigSetting } from "@npi-deck/protocol";
import { Empty, KeyValue, NeoBadge, NeoButton, SearchInput, SectionLabel, Tabs } from "@/components/neo";
import { settings } from "../../client/settings";
import { ConfigEditor, type ConfigDraft } from "./ConfigControls";
import { AdvancedNotice, advancedError, useAdvancedNotice, type AdvancedMessage } from "./AdvancedNotice";

export function ConfigSection({ revision }: { revision: number }) {
	const [data, setData] = useState<NpiConfigResponse | null>(null);
	const [failed, setFailed] = useState(false);
	const [loading, setLoading] = useState(false);
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState("");
	const { message, notify } = useAdvancedNotice();
	const refresh = useCallback(async () => {
		setLoading(true);
		try { const next = await settings.config.list(); setData(next); setFailed(false); setTab(current => next.tabs.some(item => item.id === current) ? current : next.tabs[0]?.id ?? ""); }
		catch (error) { setFailed(true); notify(advancedError(error), "warn"); }
		finally { setLoading(false); }
	}, [notify]);
	useEffect(() => { void refresh(); }, [refresh, revision]);
	const groups = useMemo(() => {
		if (!data) return [];
		const needle = query.trim().toLowerCase();
		return data.tabs.filter(item => needle || item.id === tab).flatMap(item => item.groups.map(group => ({ key: `${item.id}/${group}`, label: needle ? `${item.label} / ${group}` : group, rows: data.settings.filter(setting => setting.tab === item.id && setting.group === group && (!needle || [setting.id, setting.label, setting.description, setting.group].some(text => text.toLowerCase().includes(needle)))) }))).filter(group => group.rows.length > 0);
	}, [data, query, tab]);
	const replace = (setting: NpiConfigSetting) => setData(current => current && { ...current, settings: current.settings.map(item => item.id === setting.id ? setting : item) });
	return <div className="neo-settings-stack">
		<AdvancedNotice message={message} />
		<div className="neo-settings-advanced-heading"><p className="neo-settings-description">Every registered NeoPi setting. Saves write the global config and reload live chats. Provenance reflects the default workspace.</p><NeoButton size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}><RotateCcw size={13} />{loading ? "Loading…" : "Reload"}</NeoButton></div>
		{data ? <>
			<KeyValue items={[{ key: "Global config", value: data.configPath }, { key: "Workspace", value: data.cwd }, { key: "Registered settings", value: data.settings.length }]} />
			<SearchInput pageSearch value={query} onChange={setQuery} placeholder="Search all NeoPi settings" aria-label="Search all NeoPi settings" />
			{!query.trim() && <Tabs label="NeoPi configuration groups" className="neo-settings-advanced-config-tabs" value={tab} onChange={setTab} options={data.tabs.map(item => ({ value: item.id, label: item.label, count: data.settings.filter(setting => setting.tab === item.id).length }))} />}
			{groups.length === 0 && <Empty title="No matching settings" hint="Try another name, description or setting id." />}
			{groups.map(group => <div key={group.key}><SectionLabel>{group.label}</SectionLabel>{group.rows.map(setting => <ConfigSettingRow key={setting.id} setting={setting} cwd={data.cwd} onSaved={replace} onNotice={notify} />)}</div>)}
		</> : <Empty title={failed ? "Could not load NeoPi configuration" : "Loading NeoPi configuration…"} hint={failed ? "Reload to try the live API again." : undefined} />}
	</div>;
}

function ConfigSettingRow({ setting, cwd, onSaved, onNotice }: { setting: NpiConfigSetting; cwd: string; onSaved: (setting: NpiConfigSetting) => void; onNotice: (text: string, tone?: AdvancedMessage["tone"]) => void }) {
	const [draft, setDraft] = useState<ConfigDraft>({ dirty: false });
	const [generation, setGeneration] = useState(0);
	const [busy, setBusy] = useState(false);
	const [shown, setShown] = useState(setting);
	const discard = () => { setDraft({ dirty: false }); setGeneration(current => current + 1); };
	if (shown !== setting) { setShown(setting); discard(); }
	const locked = setting.lockedReason !== undefined;
	const invalid = draft.dirty && "error" in draft ? draft.error : undefined;
	async function run(action: () => Promise<NpiConfigPatchResponse>) {
		setBusy(true);
		try { const result = await action(); onSaved(result.setting); const summary = liveSummary(result); onNotice(summary.text, summary.tone); }
		catch (error) { onNotice(advancedError(error), "warn"); }
		finally { setBusy(false); }
	}
	return <div className="neo-settings-advanced-setting">
		<div className="neo-settings-advanced-editor"><div className="neo-settings-actions"><span className="neo-settings-advanced-label">{setting.label}</span><NeoBadge tone={setting.provenance === "env" ? "accent" : setting.provenance !== "global" && setting.provenance !== "default" ? "warn" : undefined} title="Layer supplying the effective value">{setting.provenance}</NeoBadge>{setting.secret && <NeoBadge tone="warn">secret</NeoBadge>}{locked && <NeoBadge tone="warn">locked</NeoBadge>}</div>
			<div className="neo-mono neo-settings-description">{setting.id} · {setting.type}</div>
			<p className="neo-settings-description">{setting.description || "Config-file setting without panel metadata."}</p>
			{setting.warning && <p className="neo-settings-advanced-warning">{setting.warning}</p>}
			{setting.invalidGlobalValue && <p className="neo-settings-advanced-warning">The global config value is invalid. NeoPi uses the default. Save a valid value or reset.</p>}
			{["project", "overlay", "runtime", "role", "session"].includes(setting.provenance) && <p className="neo-settings-description">A {setting.provenance} layer overrides the global value in {cwd}.</p>}
			{setting.env?.active && setting.env.fallback && <p className="neo-settings-description">{setting.provenance === "env" ? `Using $${setting.env.name} until a config value is saved.` : `Config overrides $${setting.env.name}.`}</p>}
		</div>
		<div className="neo-settings-advanced-editor">
			{setting.id === "modelRoles" ? <>
				<p className="neo-settings-description">Edit one role at a time in <Link to="/models?section=roles" className="neo-settings-advanced-link">Models / Roles</Link>. Other role mappings are kept.</p>
				<label className="neo-settings-field"><span className="neo-settings-description">Raw global/default value</span><pre className="neo-settings-advanced-json">{JSON.stringify(setting.value, null, 2) ?? "unset"}</pre></label>
				<label className="neo-settings-field"><span className="neo-settings-description">Effective value</span><pre className="neo-settings-advanced-json">{JSON.stringify(setting.effectiveValue, null, 2) ?? "unset"}</pre></label>
			</> : <>
				{locked && <p className="neo-settings-advanced-warning">{setting.lockedReason}</p>}
				{setting.secret && <p className="neo-settings-description">{setting.type === "record" ? "Values stay hidden. Saving merges only the entry fields you send and keeps every other entry and field." : setting.configured ? "A value is configured. It stays hidden; saving replaces it." : "No value configured."}</p>}
				<ConfigEditor key={generation} setting={setting} disabled={locked || busy} onChange={setDraft} />
				{invalid && <p role="alert" className="neo-settings-advanced-warning">{invalid}</p>}
				<div className="neo-settings-actions"><NeoButton size="sm" variant="primary" disabled={locked || busy || !draft.dirty || invalid !== undefined} onClick={() => { if (!draft.dirty || "error" in draft) return; const expected = setting.secret ? undefined : { value: setting.value }; void run(() => "entries" in draft ? settings.config.setEntries(setting.id, draft.entries, expected) : settings.config.set(setting.id, draft.value, expected)); }}><Save size={13} />Save</NeoButton>{draft.dirty && <NeoButton size="sm" variant="ghost" disabled={busy} onClick={discard}>Cancel</NeoButton>}<NeoButton size="sm" variant="ghost" icon disabled={locked || busy || !setting.inGlobalConfig} aria-label={`Reset ${setting.label}`} title={setting.inGlobalConfig ? "Remove this key from the global config" : "The global config does not set this key"} onClick={() => void run(() => settings.config.reset(setting.id, setting.secret ? undefined : { value: setting.value }))}><RotateCcw size={13} /></NeoButton></div>
				{!setting.secret && <p className="neo-settings-description neo-mono">Default: {preview(setting.defaultValue)}</p>}
				{!setting.secret && !["default", "global"].includes(setting.provenance) && <p className="neo-settings-description neo-mono">Effective: {preview(setting.effectiveValue)}</p>}
			</>}
		</div>
	</div>;
}
function preview(value: unknown): string { if (value === null || value === undefined) return "unset"; const text = JSON.stringify(value); return text.length > 160 ? `${text.slice(0, 157)}…` : text; }
function liveSummary(result: NpiConfigPatchResponse): AdvancedMessage {
	const saved = `Saved; resolves from ${result.setting.provenance}.`;
	if (!result.live.length) return { text: `${saved} No live chats to reload.`, tone: "ok" };
	const failed = result.live.filter(chat => chat.reloadFailed).length;
	const shadowed = new Map<string, number>();
	for (const chat of result.live) if (!chat.reloadFailed && chat.provenance !== "global" && chat.provenance !== "default") shadowed.set(chat.provenance, (shadowed.get(chat.provenance) ?? 0) + 1);
	const held = [...shadowed.values()].reduce((sum, count) => sum + count, 0);
	const chats = (count: number) => `${count} live chat${count === 1 ? "" : "s"}`;
	const parts = [`${saved} ${result.live.length - failed - held} of ${chats(result.live.length)} now use it.`];
	for (const [layer, count] of shadowed) parts.push(`${chats(count)} keep a ${layer} value.`);
	if (failed) parts.push(`${chats(failed)} failed to reload and keep their previous settings. The server log has details.`);
	return { text: parts.join(" "), tone: failed || held ? "warn" : "ok" };
}
