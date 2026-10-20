import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayText } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { invalidate as invalidateCapabilityCache } from "../capability";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import {
	CONTRACT_ENTRY,
	applyContractEvent,
	contractRequestSchema,
	contractTurnId,
	readContracts,
	requireContractId,
	type ContractEvent,
	type ContractRequest,
} from "./store";
import bundledToolDescription from "./tool.md" with { type: "text" };

const HELP =
	"/contract list | show <id> | set <id> <text> | edit <id> [text] | enable <id> | disable <id> | remove <id> | promote <id> user|project | policy on|off. JSON requests use the contract tool schema.";

export const createWorkContractsExtension =
	(agentDir: string): ExtensionFactory =>
	api => {
		const syncTool = async (ctx: ExtensionContext): Promise<void> => {
			const tools = api.getActiveTools();
			const allowed = readContracts(ctx.sessionManager).agentAllowed;
			if (allowed && !tools.includes("contract")) await api.setActiveTools([...tools, "contract"]);
			if (!allowed && tools.includes("contract"))
				await api.setActiveTools(tools.filter(name => name !== "contract"));
		};

		const execute = async (
			request: ContractRequest,
			ctx: ExtensionContext,
			actor: "user" | "agent",
			toolCallId?: string,
		): Promise<string> => {
			const state = readContracts(ctx.sessionManager);
			if (actor === "agent" && !state.agentAllowed)
				throw new Error("Contract tool is disabled. The user can enable it with /contract policy on.");
			if (request.action === "list") {
				return JSON.stringify({ agentAllowed: state.agentAllowed, clauses: [...state.clauses.values()] }, null, 2);
			}
			if (request.action === "show") {
				const clause = state.clauses.get(requireContractId(request.id));
				if (!clause) throw new Error(`No contract named ${request.id}.`);
				return JSON.stringify(clause, null, 2);
			}
			const event: ContractEvent = {
				version: 1,
				request,
				provenance: {
					actor,
					at: new Date().toISOString(),
					turnId: contractTurnId(ctx.sessionManager.getBranch()),
					...(toolCallId ? { toolCallId } : {}),
				},
			};
			if (request.action === "promote") {
				if (actor !== "user") throw new Error("Rule promotion requires an explicit /contract promote command.");
				const id = requireContractId(request.id);
				const clause = state.clauses.get(id);
				if (!clause) throw new Error(`No contract named ${id}.`);
				if (!request.scope) throw new Error("Promotion requires user or project scope.");
				const root = request.scope === "user" ? agentDir : path.join(ctx.cwd, CONFIG_DIR_NAME);
				event.promotedPath = path.join(root, "rules", `contract-${id}.md`);
				// Exclusive creation never overwrites an existing persistent rule.
				await fs.mkdir(path.dirname(event.promotedPath), { recursive: true });
				await fs.writeFile(event.promotedPath, `---\nalwaysApply: true\n---\n\n${clause.text}\n`, { flag: "wx" });
				invalidateCapabilityCache(event.promotedPath);
				invalidateCapabilityCache(path.dirname(event.promotedPath));
			}
			applyContractEvent(state, event);
			api.appendEntry(CONTRACT_ENTRY, event);
			if (request.action === "policy") await syncTool(ctx);
			return event.promotedPath
				? `Copied to ${event.promotedPath}. The session clause is unchanged. Reload rules with /reload or start a new session to load the persistent copy.`
				: `Contract ${request.action} saved${request.id ? `: ${request.id}` : ""}.`;
		};

		api.registerTool({
			name: "contract",
			label: "Session contract",
			description: resolvePromptAsset("work-contracts/tool.md", bundledToolDescription).text,
			parameters: contractRequestSchema,
			defaultInactive: true,
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				return { content: [{ type: "text", text: await execute(params, ctx, "agent", toolCallId) }] };
			},
		});
		api.registerCommand("contract", {
			description: "Manage durable session work clauses and opt in to agent edits",
			async handler(args, ctx) {
				let request: ContractRequest;
				if (args.trimStart().startsWith("{")) {
					request = contractRequestSchema.assert(JSON.parse(args));
				} else {
					const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(args.trim());
					if (!match) {
						ctx.ui.notify(HELP);
						return;
					}
					const [, action, id, rest] = match;
					if (action === "policy") {
						if (id !== "on" && id !== "off") throw new Error(HELP);
						request = { action, allowed: id === "on" };
					} else if (action === "promote") {
						request = contractRequestSchema.assert({ action, id, scope: rest });
					} else {
						request = contractRequestSchema.assert({
							action,
							...(id ? { id } : {}),
							...(rest ? { text: rest } : {}),
						});
					}
				}
				if (request.action === "edit" && request.text === undefined) {
					const clause = readContracts(ctx.sessionManager).clauses.get(requireContractId(request.id));
					if (!clause) throw new Error(`No contract named ${request.id}.`);
					if (!ctx.hasUI) throw new Error("Editing without a UI requires text or a JSON request.");
					const text = await ctx.ui.editor(`Contract: ${clause.id}`, clause.text);
					if (text === undefined) return;
					request = { ...request, text };
				}
				ctx.ui.notify(sanitizeDisplayText(await execute(request, ctx, "user")));
			},
		});
		api.on("session_start", (_event, ctx) => syncTool(ctx));
		api.on("session_switch", (_event, ctx) => syncTool(ctx));
		api.on("session_tree", (_event, ctx) => syncTool(ctx));
	};
