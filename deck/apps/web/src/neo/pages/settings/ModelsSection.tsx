import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ModelsConfigResponse, NpiModelRole, NpiModelRolesResponse } from "@npi-deck/protocol";
import { Card, Empty, NeoButton, NeoCombobox, NeoInput, NeoTextarea, Notice } from "@/components/neo";
import { roleLiveSummary } from "@/lib/model-roles";
import { settings } from "../../client/settings";
import { ModelPicker } from "../../components/ModelPicker";
import { useHiddenProviders } from "../../client/models";

export function ModelsSection() {
	return (
		<Card
			id="models"
			title="Model configuration"
			description="Roles and the model catalogue have their own workspace."
		>
			<div className="neo-settings-row">
				<p className="neo-settings-description">
					Configure inference models without leaving a conversation's model switcher open. Picker visibility
					remains under Inference providers.
				</p>
				<Link className="neo-btn" to="/models">
					Open Models
				</Link>
			</div>
		</Card>
	);
}

export function RoleAssignments() {
	const [roles, setRoles] = useState<NpiModelRolesResponse | null>(null);
	const [notice, setNotice] = useState("");
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [newRole, setNewRole] = useState("");
	const [newSelector, setNewSelector] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const refresh = useCallback(async () => {
		try {
			setRoles(await settings.config.modelRoles());
			setFailed(false);
		} catch (error) {
			setNotice(String(error));
			setFailed(true);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	async function saved(note: string) {
		setNotice(note);
		await refresh();
	}
	async function create() {
		if (!roles) return;
		setBusy(true);
		try {
			await settings.config.setEntries(
				"modelRoles",
				{ [newRole.trim()]: newSelector.trim() },
				{ value: roles.setting.value },
			);
			setNewRole("");
			setNewSelector("");
			setCreating(false);
			await saved("Role saved.");
		} catch (error) {
			setNotice(String(error));
		} finally {
			setBusy(false);
		}
	}
	const locked = !roles || !!roles.setting.lockedReason || roles.setting.invalidGlobalValue;
	const selectedRole = roles?.roles.find(role => role.id === selected);
	return (
		<Card
			title="Roles"
			description="A role is an inference policy such as @default, not an agent template."
			actions={
				<NeoButton size="sm" variant="ghost" onClick={() => void refresh()}>
					Reload
				</NeoButton>
			}
		>
			<div className="neo-settings-stack">
				{notice && <Notice>{notice}</Notice>}
				<p className="neo-settings-description">
					Edits apply to the global NeoPi configuration. Project and runtime overrides remain in place. A stale
					save is rejected rather than overwriting another client's changes.
				</p>
				{roles?.setting.lockedReason && <Notice tone="warn">{roles.setting.lockedReason}</Notice>}
				{!roles && (
					<Empty
						title={failed ? "Could not load model roles" : "Loading model roles"}
						hint={failed ? "Check the NeoPi connection, then reload." : undefined}
					/>
				)}
				{roles && (selectedRole || creating) && (
					<NeoButton
						variant="ghost"
						onClick={() => {
							setSelected(null);
							setCreating(false);
						}}
					>
						Back to roles
					</NeoButton>
				)}
				{roles && selectedRole && (
					<RoleEditor
						key={`${selectedRole.id}-${selectedRole.value}`}
						role={selectedRole}
						expectedValue={roles.setting.value}
						allowedModels={roles.pools[selectedRole.pool]?.models ?? []}
						disabled={locked}
						onSaved={saved}
					/>
				)}
				{roles && !selectedRole && !creating && (
					<>
						<div className="neo-model-role-list">
							{roles.roles.map(role => (
								<button
									type="button"
									className="neo-model-role-summary"
									key={role.id}
									onClick={() => setSelected(role.id)}
								>
									<span>
										<strong>{role.name}</strong>
										<span className="neo-settings-description neo-mono">@{role.id}</span>
									</span>
									<span className="neo-settings-description neo-mono">
										{role.effectiveValue ?? "Built-in chain"}
									</span>
									<span className="neo-settings-description">{role.provenance}</span>
								</button>
							))}
						</div>
						<NeoButton disabled={locked} onClick={() => setCreating(true)}>
							Add a role
						</NeoButton>
					</>
				)}
				{roles && creating && (
					<div className="neo-settings-new-role">
						<h3>Add a role</h3>
						<div className="neo-settings-form-grid">
							<label className="neo-settings-field">
								Role name
								<NeoInput
									value={newRole}
									onChange={event => setNewRole(event.target.value)}
									placeholder="review"
									disabled={locked || busy}
								/>
							</label>
							<label className="neo-settings-field">
								Model or pattern
								<NeoInput
									mono
									value={newSelector}
									onChange={event => setNewSelector(event.target.value)}
									placeholder="provider/model or @role"
									disabled={locked || busy}
								/>
							</label>
						</div>
						<NeoButton
							disabled={
								locked ||
								busy ||
								!newRole.trim() ||
								!newSelector.trim() ||
								roles.roles.some(role => role.id === newRole.trim())
							}
							onClick={() => void create()}
						>
							Add role
						</NeoButton>
					</div>
				)}
			</div>
		</Card>
	);
}

function RoleEditor({
	role,
	expectedValue,
	allowedModels,
	disabled,
	onSaved,
}: {
	role: NpiModelRole;
	expectedValue: unknown;
	allowedModels: string[];
	disabled: boolean;
	onSaved: (note: string) => Promise<void>;
}) {
	const [selector, setSelector] = useState(role.value ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const hiddenProviders = useHiddenProviders();
	async function save() {
		setBusy(true);
		setError("");
		try {
			const value = selector.trim() || null;
			const result = await settings.config.setEntries("modelRoles", { [role.id]: value }, { value: expectedValue });
			await onSaved(roleLiveSummary(result, role.id, value).text);
		} catch (error) {
			setError(String(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="neo-settings-role">
			<div className="neo-settings-stack">
				<strong>
					{role.name} <span className="neo-settings-description neo-mono">@{role.id}</span>
				</strong>
				<span className="neo-settings-description">
					Effective source: {role.provenance}
					{role.hidden ? ". Hidden from NeoPi's role carousel." : ""}
				</span>
				<span className="neo-settings-description">
					{role.resolved ? (
						<>
							Resolves to{" "}
							<span className="neo-mono">
								{role.resolved.provider}/{role.resolved.modelId}
								{role.resolved.thinkingLevel ? `:${role.resolved.thinkingLevel}` : ""}
							</span>
						</>
					) : (
						"No available model currently resolves this role."
					)}
				</span>
			</div>
			<div className="neo-settings-stack">
				{role.section === "chat" ? (
					<ModelPicker value={selector} onChange={setSelector} disabled={disabled || busy} excludeRole={role.id} />
				) : (
					<NeoCombobox
						aria-label={`Model for ${role.name}`}
						value={selector}
						onValueChange={setSelector}
						options={allowedModels
							.filter(value => !hiddenProviders.has(value.slice(0, value.indexOf("/"))))
							.map(value => ({ value, label: value }))}
						allowCustom
						disabled={disabled || busy}
					/>
				)}
				<label className="neo-settings-field">
					Global selector
					<NeoInput
						mono
						aria-label={`Selector for ${role.id}`}
						value={selector}
						onChange={event => setSelector(event.target.value)}
						placeholder="Unset, use the built-in chain"
						disabled={disabled || busy}
					/>
				</label>
				{role.effectiveValue !== role.value && (
					<p className="neo-settings-description">
						Effective selector: <span className="neo-mono">{role.effectiveValue ?? "Built-in chain"}</span>
					</p>
				)}
				{error && <Notice tone="warn">{error}</Notice>}
				<div className="neo-settings-actions">
					<NeoButton
						size="sm"
						variant="primary"
						disabled={disabled || busy || selector === (role.value ?? "")}
						onClick={() => void save()}
					>
						Save role
					</NeoButton>
					<NeoButton
						size="sm"
						variant="ghost"
						disabled={disabled || busy || !selector}
						onClick={() => setSelector("")}
					>
						Clear global assignment
					</NeoButton>
				</div>
			</div>
		</div>
	);
}

export function CustomModelsEditor() {
	const [doc, setDoc] = useState<ModelsConfigResponse | null>(null);
	const [text, setText] = useState("");
	const [notice, setNotice] = useState("");
	const [valid, setValid] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const refresh = useCallback(async () => {
		try {
			const result = await settings.models.load();
			setDoc(result);
			setText(result.raw ?? "");
			setValid(null);
		} catch (error) {
			setNotice(String(error));
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	async function validate() {
		setBusy(true);
		try {
			const result = await settings.models.validate(text);
			setValid(text);
			setNotice(`Valid. ${result.providers.length} custom providers.`);
		} catch (error) {
			setValid(null);
			setNotice(String(error));
		} finally {
			setBusy(false);
		}
	}
	async function save() {
		if (!doc) return;
		setBusy(true);
		try {
			const result = await settings.models.save(text, doc.revision);
			setDoc(result);
			setText(result.raw ?? "");
			setValid(null);
			setNotice(result.registry.error ?? "Saved. The model catalogue has refreshed.");
		} catch (error) {
			setNotice(String(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Card
			title="Custom model definitions"
			description="Advanced catalogue extensions in models.toml, separate from role assignments."
			actions={
				<NeoButton size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
					Reload
				</NeoButton>
			}
		>
			<div className="neo-settings-stack">
				{notice && <Notice>{notice}</Notice>}
				<p className="neo-settings-description">
					Masked credentials, URLs and comments retain their stored values. The server validates the document and
					checks its revision before saving.
				</p>
				{doc?.error && <Notice tone="warn">{doc.error}</Notice>}
				{doc?.raw === null ? (
					<Notice tone="warn">{doc.rawUnavailable}</Notice>
				) : (
					<NeoTextarea
						mono
						aria-label="models.toml document"
						value={text}
						onChange={event => {
							setText(event.target.value);
							setValid(null);
						}}
						spellCheck={false}
						rows={12}
						disabled={!doc || busy}
					/>
				)}
				<div className="neo-settings-actions">
					<NeoButton disabled={!doc || busy || doc.raw === null} onClick={() => void validate()}>
						Validate
					</NeoButton>
					<NeoButton
						variant="primary"
						disabled={busy || !doc || valid !== text || text === doc.raw}
						onClick={() => void save()}
					>
						Save definitions
					</NeoButton>
				</div>
				{doc && <span className="neo-settings-description neo-mono neo-settings-file-path">{doc.path}</span>}
			</div>
		</Card>
	);
}
