import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import { logger } from "@oh-my-pi/pi-utils";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import addedTemplate from "../prompts/system/irc-group-added.md" with { type: "text" };
import messageTemplate from "../prompts/system/irc-group-message.md" with { type: "text" };
import reminderTemplate from "../prompts/system/irc-group-reminder.md" with { type: "text" };
import type { AgentRef, AgentRegistryApi } from "../registry/agent-registry";
import { isCurrentSessionRosterRef } from "../registry/persisted-agents";
import type { SessionEntry } from "../session/session-entries";
import type { IrcBusApi } from "./bus";

export const IRC_EVERYONE = "everyone";
export const IRC_SINGLE_MEMBER_MINUTES = 10;
export const IRC_KEEP_MINUTES = 5;
const MINUTE_MS = 60_000;

export type IrcGroupRequest =
	| { op: "send"; group: string; message: string }
	| { op: "create" | "add" | "remove"; group: string; members: string[] }
	| { op: "leave"; group: string }
	| { op: "members"; group: string }
	| { op: "keep"; group: string; reason: string }
	| { op: "groups" | "my_groups" };

export interface IrcGroupResult {
	text: string;
	isError?: boolean;
	receipts?: IrcDeliveryReceipt[];
}

interface Group {
	members: Set<string>;
	deadline?: number;
	timer?: NodeJS.Timeout;
}

export const IRC_GROUPS_CUSTOM_TYPE = "irc-groups";

export interface IrcGroupSnapshot {
	groups: { name: string; members: string[]; deadline?: number }[];
	everyoneOptOuts: string[];
	everyoneAdvisors: string[];
}

export function readIrcGroupSnapshot(branch: readonly SessionEntry[]): IrcGroupSnapshot | undefined {
	for (let i = branch.length - 1; i >= 0; --i) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === IRC_GROUPS_CUSTOM_TYPE) {
			const snapshot = entry.data as IrcGroupSnapshot | undefined;
			if (
				Array.isArray(snapshot?.groups) &&
				Array.isArray(snapshot.everyoneOptOuts) &&
				Array.isArray(snapshot.everyoneAdvisors)
			)
				return snapshot;
		}
	}
	return undefined;
}

interface GroupPersistence {
	isCurrent(): boolean;
	save(snapshot: IrcGroupSnapshot): void;
}

function isParticipant(ref: AgentRef | undefined): ref is AgentRef {
	if (!ref || ref.status === "aborted" || ref.kind === "mailbox") return false;
	// Live advisors can speak and belong to named groups, but the bus still
	// refuses incoming messages to their read-only transcripts.
	if (ref.kind === "advisor") return ref.status === "idle" || ref.status === "running";
	return !ref.history?.readOnly;
}

/** Main IRC host's address lists. Messages still live only in each recipient's own session. */
export class IrcGroups {
	readonly #groups = new Map<string, Group>([[IRC_EVERYONE, { members: new Set() }]]);
	readonly #everyoneOptOuts: Set<string>;
	readonly #everyoneAdvisors: Set<string>;
	readonly #unsubscribe: () => void;
	#restorePending: boolean;

	constructor(
		private readonly registry: AgentRegistryApi,
		private readonly bus: Pick<IrcBusApi, "send">,
		snapshot?: IrcGroupSnapshot,
		private readonly persistence?: GroupPersistence,
	) {
		this.#restorePending = snapshot !== undefined;
		this.#everyoneOptOuts = new Set(snapshot?.everyoneOptOuts);
		this.#everyoneAdvisors = new Set(snapshot?.everyoneAdvisors);
		const everyone = this.#groups.get(IRC_EVERYONE)!;
		for (const ref of registry.list()) {
			if (this.#joinsEveryone(ref)) everyone.members.add(ref.id);
		}
		this.#unsubscribe = registry.onChange(({ type, ref }) => {
			if (this.persistence && !this.persistence.isCurrent()) return;
			if (type === "removed" || !isParticipant(ref)) {
				let changed = !this.#restorePending && this.#everyoneAdvisors.delete(ref.id);
				for (const [name, group] of this.#groups) {
					if (!group.members.delete(ref.id)) continue;
					this.#resize(name, group);
					if (name !== IRC_EVERYONE) changed = true;
				}
				if (changed) this.#save();
			} else if (type === "registered" && this.#joinsEveryone(ref)) {
				everyone.members.add(ref.id);
			}
		});
	}

	/** Prune against the registry only after the persisted child roster has been loaded. */
	restore(snapshot: IrcGroupSnapshot, sessionFile: string | undefined): void {
		let changed = false;
		for (const id of this.#everyoneAdvisors) {
			if (!this.#isRestorableMember(id, sessionFile)) {
				this.#everyoneAdvisors.delete(id);
				this.#groups.get(IRC_EVERYONE)!.members.delete(id);
				changed = true;
			}
		}
		for (const { name, members, deadline } of snapshot.groups) {
			const group: Group = {
				members: new Set(members.filter(id => this.#isRestorableMember(id, sessionFile))),
			};
			if (group.members.size !== members.length) changed = true;
			if (!group.members.size || (group.members.size === 1 && deadline !== undefined && deadline <= Date.now())) {
				changed = true;
				continue;
			}
			this.#groups.set(name, group);
			if (group.members.size === 1) {
				if (deadline === undefined) {
					this.#resize(name, group);
					changed = true;
				} else {
					this.#scheduleExpiry(name, group, deadline);
				}
			}
		}
		this.#restorePending = false;
		if (changed) this.#save();
	}

	#isRestorableMember(id: string, sessionFile: string | undefined): boolean {
		const ref = this.registry.get(id);
		return isParticipant(ref) && isCurrentSessionRosterRef(ref, sessionFile);
	}

	#joinsEveryone(ref: AgentRef): boolean {
		return (
			isParticipant(ref) &&
			!this.#everyoneOptOuts.has(ref.id) &&
			(ref.kind !== "advisor" || this.#everyoneAdvisors.has(ref.id))
		);
	}

	#save(): void {
		if (this.#restorePending || !this.persistence?.isCurrent()) return;
		const groups: IrcGroupSnapshot["groups"] = [];
		for (const [name, { members, deadline }] of this.#groups) {
			if (name !== IRC_EVERYONE) groups.push({ name, members: [...members], deadline });
		}
		this.persistence.save({
			groups,
			everyoneOptOuts: [...this.#everyoneOptOuts],
			everyoneAdvisors: [...this.#everyoneAdvisors],
		});
	}

	dispose(): void {
		this.#unsubscribe();
		for (const group of this.#groups.values()) clearTimeout(group.timer);
	}

	filterBroadcastTargets(targets: string[]): string[] {
		const members = this.#groups.get(IRC_EVERYONE)!.members;
		return targets.filter(id => members.has(id));
	}

	async execute(sender: string, request: IrcGroupRequest): Promise<IrcGroupResult> {
		const actor = this.registry.get(sender);
		if (!isParticipant(actor)) return { text: `Unknown IRC participant ${sender}.`, isError: true };
		if (!("group" in request)) {
			const groups: string[] = [];
			for (const [name, group] of this.#groups) {
				if (request.op === "groups" || group.members.has(sender)) groups.push(`${name} (${group.members.size})`);
			}
			return { text: groups.length ? groups.join("\n") : "No IRC groups." };
		}

		const name = request.group.trim();
		const group = this.#groups.get(name);
		const label = actor.kind === "operator" ? "The operator" : sender;
		if (request.op === "create") {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
				return {
					text: "Use an IRC group name made of letters, digits, hyphens, or underscores, starting with a letter or digit.",
					isError: true,
				};
			}
			if (group) return { text: `IRC group ${name} already exists.`, isError: true };
			return this.#add(sender, name, { members: new Set() }, request.members, true);
		}
		if (!group) return { text: `Unknown IRC group ${name}.`, isError: true };

		switch (request.op) {
			case "send": {
				if (!request.message.trim()) return { text: "A non-empty message is required.", isError: true };
				const heading = renderPromptAsset("system/irc-group-message.md", messageTemplate, {
					sender: label,
					group: name,
				}).trimEnd();
				const body = `${heading}\n\n${request.message}`;
				const receipts = await Promise.all(
					[...group.members].map(to =>
						this.bus.send(
							{ from: sender, to, body, localOnly: true, broadcast: true },
							{ suppressRelay: true, broadcast: true, groupDelivery: true },
						),
					),
				);
				const failed = receipts.filter(receipt => receipt.outcome === "failed");
				const delivered = receipts.length - failed.length;
				return {
					text: [
						`Delivered to ${delivered} of ${receipts.length} member(s) of IRC group ${name}.`,
						...failed.map(receipt => `${receipt.to}: ${receipt.error ?? "delivery failed"}`),
					].join("\n"),
					receipts,
					isError: delivered === 0,
				};
			}
			case "members":
				return { text: `Members of IRC group ${name}: ${[...group.members].join(", ") || "none"}.` };
			case "add":
				return this.#add(sender, name, group, request.members, false);
			case "remove":
			case "leave": {
				const members = request.op === "leave" ? [sender] : request.members;
				const removed: string[] = [];
				for (const member of members) {
					const id = member.trim();
					if (!group.members.delete(id)) continue;
					removed.push(id);
					if (name === IRC_EVERYONE) {
						this.#everyoneOptOuts.add(id);
						this.#everyoneAdvisors.delete(id);
					}
				}
				if (!removed.length) return { text: `No matching members in IRC group ${name}.`, isError: true };
				this.#resize(name, group);
				this.#save();
				return {
					text: `Removed ${removed.join(", ")} from IRC group ${name}.${this.#groups.has(name) ? "" : " Empty group deleted."}`,
				};
			}
			case "keep": {
				if (!group.members.has(sender) || group.deadline === undefined) {
					return { text: "Only the sole member of an expiring group can extend it.", isError: true };
				}
				const reason = request.reason.trim();
				if (!reason) return { text: "A reason is required to keep a group.", isError: true };
				this.#scheduleExpiry(name, group, group.deadline + IRC_KEEP_MINUTES * MINUTE_MS);
				this.#save();
				return { text: `Kept IRC group ${name} for ${IRC_KEEP_MINUTES} more minutes: ${reason}` };
			}
		}
	}

	async #add(sender: string, name: string, group: Group, members: string[], create: boolean): Promise<IrcGroupResult> {
		if (!members.length) return { text: "At least one IRC member is required.", isError: true };
		const ids = new Set(members.map(id => id.trim()));
		for (const id of ids) {
			if (!isParticipant(this.registry.get(id)))
				return { text: `Unknown IRC participant ${JSON.stringify(id)}.`, isError: true };
		}
		const added: string[] = [];
		for (const id of ids) {
			if (group.members.has(id)) continue;
			group.members.add(id);
			if (name === IRC_EVERYONE) {
				this.#everyoneOptOuts.delete(id);
				if (this.registry.get(id)?.kind === "advisor") this.#everyoneAdvisors.add(id);
			}
			added.push(id);
		}
		if (!added.length) return { text: `No new members added to IRC group ${name}.` };
		if (create) this.#groups.set(name, group);
		const notice = renderPromptAsset("system/irc-group-added.md", addedTemplate, { group: name }).trimEnd();
		const notices = added.map(to => this.#notice(sender, to, notice));
		this.#resize(name, group);
		this.#save();
		await Promise.all(notices);
		return { text: `${create ? "Created" : "Updated"} IRC group ${name}; added ${added.join(", ")}.` };
	}

	#resize(name: string, group: Group): void {
		if (name === IRC_EVERYONE) return;
		clearTimeout(group.timer);
		group.timer = undefined;
		group.deadline = undefined;
		if (group.members.size === 0) {
			this.#groups.delete(name);
		} else if (group.members.size === 1) {
			const [member] = group.members;
			this.#scheduleExpiry(name, group, Date.now() + IRC_SINGLE_MEMBER_MINUTES * MINUTE_MS);
			const notice = renderPromptAsset("system/irc-group-reminder.md", reminderTemplate, {
				group: name,
				minutes: IRC_SINGLE_MEMBER_MINUTES,
			}).trimEnd();
			void this.#notice(member!, member!, notice);
		}
	}

	#scheduleExpiry(name: string, group: Group, deadline: number): void {
		clearTimeout(group.timer);
		group.deadline = deadline;
		group.timer = setTimeout(() => {
			if (this.#groups.delete(name)) this.#save();
		}, deadline - Date.now());
		group.timer.unref?.();
	}

	async #notice(from: string, to: string, body: string): Promise<void> {
		try {
			const receipt = await this.bus.send(
				{ from, to, body, localOnly: true, broadcast: true },
				{ suppressRelay: true, groupDelivery: true },
			);
			if (receipt.outcome === "failed") logger.debug("IRC group notice not delivered", { to, error: receipt.error });
		} catch (error) {
			logger.debug("IRC group notice not delivered", { to, error: String(error) });
		}
	}
}
