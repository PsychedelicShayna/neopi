import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
/**
 * Tools of the two `/issue` agents (#305). The resolver gets only
 * `issue_target`; the author gets read-only tracker access plus one
 * publication path pinned to the resolved repository. Filing-only authority
 * is structural: neither agent has a shell, an editor, or a generic `gh`.
 */
import { type } from "@oh-my-pi/omptype";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { githubRepoSlugEquals } from "../tools/gh-common";
import { github } from "../utils/github";
import declineDescription from "./prompts/tool-decline.md" with { type: "text" };
import existingOwnerDescription from "./prompts/tool-existing-owner.md" with { type: "text" };
import labelsDescription from "./prompts/tool-labels.md" with { type: "text" };
import publishDescription from "./prompts/tool-publish.md" with { type: "text" };
import samplesDescription from "./prompts/tool-samples.md" with { type: "text" };
import searchDescription from "./prompts/tool-search.md" with { type: "text" };
import targetDescription from "./prompts/tool-target.md" with { type: "text" };
import viewDescription from "./prompts/tool-view.md" with { type: "text" };
import { selectIssueSamples } from "./samples";
import {
	type IssueCheckout,
	type IssueRepoCandidate,
	type IssueTargetInventory,
	selectIssueCheckout,
	verifyIssueCheckout,
} from "./target-inventory";

/** Upper bound on one issue body or comment returned to the authoring agent. */
const ISSUE_TEXT_LIMIT = 12_000;
/** Issues returned by one `issue_search`. */
const SEARCH_LIMIT = 30;
/** Own recent issues inspected when reconciling an uncertain create. */
const OWN_RECENT_LIMIT = 30;
/** Issue numbers fetched for sampling; generous enough for any tracker this command targets. */
const SAMPLE_HISTORY_LIMIT = 10_000;
/** Labels fetched for validation. */
const LABEL_LIMIT = 1_000;

/** The repository and checkout the resolver settled on. */
export interface IssueTargetSelection {
	candidate: IssueRepoCandidate;
	checkout: IssueCheckout;
	reason: string;
}

/** An issue exactly as GitHub recorded it after publication. */
export interface PublishedIssue {
	repo: string;
	number: number;
	url: string;
	title: string;
	body: string;
	labels: string[];
}

/** GitHub confirmed creation, independently of whether its full record can be read. */
export interface CreatedIssue {
	repo: string;
	url: string;
}

/** A write attempt stays uncertain until GitHub identifies the created issue. */
export type IssuePublicationState =
	| { kind: "uncertain"; repo: string; title: string }
	| { kind: "created"; issue: CreatedIssue };

/** An existing issue the author reported as the owner instead of publishing. */
export interface ExistingIssueOwner {
	repo: string;
	number: number;
	url: string;
	title: string;
	reason: string;
	draft: string;
}

/** How one `/issue` request ended. */
export type IssueFilingOutcome =
	| { kind: "published"; issue: PublishedIssue }
	| { kind: "published-unread"; issue: CreatedIssue }
	| { kind: "publication-uncertain"; repo: string; title: string }
	| { kind: "existing-owner"; owner: ExistingIssueOwner }
	| { kind: "declined"; reason: string };

const declineSchema = type({
	reason: type("string > 0").describe("why nothing is filed, in terms the operator recognizes"),
	"+": "reject",
});

/**
 * `issue_decline`: end the request without filing. `blocked` returns why the
 * request can no longer be declined (an outcome or publication already holds).
 */
export function createIssueDeclineTool(options: {
	onDecline: (reason: string) => void;
	blocked?: () => string | undefined;
}): CustomTool {
	let declined = false;
	return {
		name: "issue_decline",
		label: "Decline filing",
		description: resolvePromptAsset("issues/tool-decline.md", declineDescription).text.trim(),
		parameters: declineSchema,
		approval: "read",
		strict: true,
		loadMode: "essential",
		execute: async (_toolCallId, rawParams) => {
			const params = declineSchema(rawParams);
			if (params instanceof type.errors)
				throw new Error(`issue_decline received invalid arguments: ${params.summary}`);
			if (declined) return textResult("Already declined; end your turn.");
			const blocked = options.blocked?.();
			if (blocked) throw new Error(blocked);
			declined = true;
			options.onDecline(params.reason);
			return textResult("Declined; nothing was filed. End your turn.");
		},
	};
}

interface GhLabelRow {
	name: string;
	description?: string;
}

interface GhIssueRow {
	number: number;
	title: string;
	url: string;
	state?: string;
	createdAt?: string;
	body?: string;
	labels?: { name: string }[];
	author?: { login?: string };
	comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
}

const ISSUE_VIEW_FIELDS = "number,title,url,state,createdAt,body,labels,author,comments";
const ISSUE_ROW_FIELDS = "number,title,url,state,createdAt,labels";

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function clip(text: string | undefined): string {
	const value = text ?? "";
	if (value.length <= ISSUE_TEXT_LIMIT) return value;
	return `${value.slice(0, ISSUE_TEXT_LIMIT)}\n[… truncated at ${ISSUE_TEXT_LIMIT} characters]`;
}

function labelNames(row: GhIssueRow): string[] {
	return (row.labels ?? []).map(label => label.name);
}

function formatIssueRow(row: GhIssueRow): string {
	const labels = labelNames(row);
	return `#${row.number} [${row.state ?? "?"}] ${row.title}${labels.length > 0 ? ` (labels: ${labels.join(", ")})` : ""} ${row.url}`;
}

function formatIssue(row: GhIssueRow, includeComments: boolean): string {
	const lines = [
		`# #${row.number} ${row.title}`,
		`State: ${row.state ?? "?"} · Created: ${row.createdAt ?? "?"} · Author: ${row.author?.login ?? "?"}`,
		`Labels: ${labelNames(row).join(", ") || "none"}`,
		`URL: ${row.url}`,
		"",
		clip(row.body),
	];
	if (includeComments) {
		for (const comment of row.comments ?? []) {
			lines.push(
				"",
				`## Comment by ${comment.author?.login ?? "?"} at ${comment.createdAt ?? "?"}`,
				"",
				clip(comment.body),
			);
		}
	}
	return lines.join("\n");
}

const targetSchema = type({
	repo: type("string > 0").describe("inventory repository, exactly as listed"),
	reason: type("string > 0").describe("operator words that identify it, and any nickname mapped"),
	"+": "reject",
});

/**
 * Resolver tool: validate the chosen repository against the inventory and a
 * freshly verified local checkout, then hand the selection to `onSelect`.
 */
export function createIssueTargetTool(options: {
	inventory: IssueTargetInventory;
	onSelect: (selection: IssueTargetSelection) => void;
}): CustomTool {
	let selected: IssueTargetSelection | undefined;
	// Read through a function: a parallel call may select across an await.
	const priorSelection = (repo: string) => {
		const current = selected;
		if (!current) return undefined;
		if (githubRepoSlugEquals(current.candidate.repo, repo)) {
			return textResult(`Already selected ${current.candidate.repo}.`);
		}
		throw new Error(`A target was already selected (${current.candidate.repo}); it cannot be changed.`);
	};
	return {
		name: "issue_target",
		label: "Issue target",
		description: resolvePromptAsset("issues/tool-target.md", targetDescription).text.trim(),
		parameters: targetSchema,
		approval: "read",
		strict: true,
		loadMode: "essential",
		execute: async (_toolCallId, rawParams, _onUpdate, _ctx, signal) => {
			const params = targetSchema(rawParams);
			if (params instanceof type.errors)
				throw new Error(`issue_target received invalid arguments: ${params.summary}`);
			const repeated = priorSelection(params.repo);
			if (repeated) return repeated;
			const candidate = options.inventory.repositories.find(entry => githubRepoSlugEquals(entry.repo, params.repo));
			if (!candidate) throw new Error(`${params.repo} is not in the inventory.`);
			if (candidate.issuesEnabled === false) throw new Error(`${candidate.repo} has issues disabled.`);
			if (candidate.archived) throw new Error(`${candidate.repo} is archived; its issues are read-only.`);
			const checkout = selectIssueCheckout(candidate, options.inventory.foreground?.repoRoot);
			if (!checkout) {
				throw new Error(
					`${candidate.repo} has no local checkout. /issue does not clone; open a session in a checkout or map one in the issues.checkouts setting.`,
				);
			}
			if (!(await verifyIssueCheckout(checkout, candidate.repo, signal))) {
				throw new Error(`Checkout ${checkout.path} no longer has a remote for ${candidate.repo}.`);
			}
			const raced = priorSelection(candidate.repo);
			if (raced) return raced;
			selected = { candidate, checkout, reason: params.reason };
			options.onSelect(selected);
			return textResult(`Selected ${candidate.repo} (checkout ${checkout.path}). Your part is done; end your turn.`);
		},
	};
}

const searchSchema = type({
	query: type("string > 0").describe("GitHub issue search terms"),
	"+": "reject",
});

const viewSchema = type({
	number: type("number.integer >= 1").describe("issue number"),
	"+": "reject",
});

const publishSchema = type({
	title: type("string > 0").describe("issue title"),
	body: type("string > 0").describe("complete Markdown body"),
	labels: type("string[]").describe("existing label names; empty when the rules call for none"),
	"assignees?": type("string[]").describe("GitHub logins, only when the repository's rules require them"),
	"milestone?": type("string > 0").describe("milestone title, only when the repository's rules require it"),
	"+": "reject",
});

const existingOwnerSchema = type({
	number: type("number.integer >= 1").describe("owning issue number"),
	reason: type("string > 0").describe("why it owns the subject"),
	draft: type("string > 0").describe("amendment the operator may post"),
	"+": "reject",
});

const emptySchema = type({ "+": "reject" });

/** Inputs the author tools close over; every GitHub call is pinned to `repo`. */
export interface IssueAuthorToolOptions {
	repo: string;
	checkout: IssueCheckout;
	/** Epoch ms the request started; bounds the reconciliation of an uncertain create. */
	startedAt: number;
	onOutcome: (outcome: IssueFilingOutcome) => void;
	onPublication: (state: IssuePublicationState) => void;
	random?: () => number;
}

/**
 * Author tools. `issue_publish` is exactly-once: concurrent and repeated calls
 * share one publication. Once a create is attempted, later calls only read its
 * known reference or reconcile the original title/body; a failed lookup never
 * grants authority for a second create.
 */
export function createIssueAuthorTools(options: IssueAuthorToolOptions): CustomTool[] {
	const { repo, checkout } = options;
	const cwd = checkout.path;
	let outcome: IssueFilingOutcome | undefined;
	let publication: Promise<PublishedIssue> | undefined;
	// Once GitHub confirms creation, retries may read this issue but never create another.
	let createdIssueRef: string | undefined;
	let uncertainCreate: { title: string; body: string } | undefined;
	// Set synchronously when issue_existing_owner starts, before it awaits, so a
	// publish in the same parallel tool batch cannot also file.
	let ownerClaim: Promise<GhIssueRow> | undefined;

	const listLabels = (signal: AbortSignal | undefined) =>
		github.json<GhLabelRow[]>(
			cwd,
			["label", "list", "--repo", repo, "--limit", String(LABEL_LIMIT), "--json", "name,description"],
			signal,
			{ repoProvided: true },
		);

	/** GitHub stores bodies with normalized line endings and trims trailing whitespace. */
	const normalizeBody = (value: string | undefined) => (value ?? "").replace(/\r\n/g, "\n").trim();

	const viewIssue = (ref: string, signal: AbortSignal | undefined) =>
		github.json<GhIssueRow>(cwd, ["issue", "view", ref, "--repo", repo, "--json", ISSUE_VIEW_FIELDS], signal, {
			repoProvided: true,
		});

	/**
	 * After a create whose outcome is unknown, find the issue it may have made:
	 * the operator's own, created since the request started, with this exact
	 * title and body. Never consulted before a create, so an unrelated
	 * same-title issue cannot stand in for the requested publication.
	 */
	const findUncertainCreate = async (title: string, body: string): Promise<GhIssueRow | undefined> => {
		const rows = await github.json<GhIssueRow[]>(
			cwd,
			[
				"issue",
				"list",
				"--repo",
				repo,
				"--state",
				"all",
				"--author",
				"@me",
				"--limit",
				String(OWN_RECENT_LIMIT),
				"--json",
				`${ISSUE_ROW_FIELDS},body`,
			],
			undefined,
			{ repoProvided: true },
		);
		// One minute of slack absorbs clock skew between this host and GitHub.
		const since = options.startedAt - 60_000;
		const expectedBody = normalizeBody(body);
		return rows.find(
			row =>
				row.title === title && normalizeBody(row.body) === expectedBody && Date.parse(row.createdAt ?? "") >= since,
		);
	};

	const toPublished = (row: GhIssueRow): PublishedIssue => ({
		repo,
		number: row.number,
		url: row.url,
		title: row.title,
		body: row.body ?? "",
		labels: labelNames(row),
	});

	const recordCreated = (ref: string, url: string) => {
		createdIssueRef = ref;
		options.onPublication({ kind: "created", issue: { repo, url } });
	};

	const reconcilePublication = async (title: string, body: string, cause?: unknown): Promise<PublishedIssue> => {
		// Unbound from cancellation: a cancelled request may already have created the issue.
		const reconciled = await findUncertainCreate(title, body);
		if (!reconciled)
			throw new Error("Issue creation has not been confirmed; no second create will be attempted.", { cause });
		const ref = String(reconciled.number);
		recordCreated(ref, reconciled.url);
		return toPublished(await viewIssue(ref, undefined));
	};

	const publishOnce = async (
		params: { title: string; body: string; labels: string[]; assignees?: string[]; milestone?: string },
		signal: AbortSignal | undefined,
	): Promise<PublishedIssue> => {
		if (createdIssueRef) return toPublished(await viewIssue(createdIssueRef, undefined));
		if (uncertainCreate) return await reconcilePublication(uncertainCreate.title, uncertainCreate.body);
		const available = new Set((await listLabels(signal)).map(label => label.name));
		const unknown = params.labels.filter(label => !available.has(label));
		if (unknown.length > 0) {
			throw new Error(`Unknown labels (not created): ${unknown.join(", ")}. Use names from issue_labels.`);
		}
		if (!(await verifyIssueCheckout(checkout, repo, signal))) {
			throw new Error(`Checkout ${cwd} no longer has a remote for ${repo}; nothing was published.`);
		}

		await using bodyDir = await TempDir.create("@npi-issue-body-");
		const bodyFile = bodyDir.join("body.md");
		await Bun.write(bodyFile, params.body);
		const args = ["issue", "create", "--repo", repo, "--title", params.title, "--body-file", bodyFile];
		for (const label of params.labels) args.push("--label", label);
		for (const assignee of params.assignees ?? []) args.push("--assignee", assignee);
		if (params.milestone) args.push("--milestone", params.milestone);
		uncertainCreate = { title: params.title, body: params.body };
		options.onPublication({ kind: "uncertain", repo, title: params.title });

		let created: { exitCode: number; stdout: string; stderr: string } | undefined;
		let createError: unknown;
		try {
			created = await github.run(cwd, args, signal, { repoProvided: true });
		} catch (error) {
			createError = error;
		}
		const url =
			created?.exitCode === 0 ? created.stdout.split("\n").findLast(line => line.startsWith("https://")) : undefined;
		if (url) {
			recordCreated(url, url);
			return toPublished(await viewIssue(url, undefined));
		}
		return await reconcilePublication(
			uncertainCreate.title,
			uncertainCreate.body,
			createError ?? new Error(`gh issue create failed: ${created?.stderr || created?.stdout || "no output"}`),
		);
	};

	const settle = (next: IssueFilingOutcome) => {
		outcome = next;
		options.onOutcome(next);
	};

	return [
		{
			name: "issue_labels",
			label: "Issue labels",
			description: resolvePromptAsset("issues/tool-labels.md", labelsDescription).text.trim(),
			parameters: emptySchema,
			approval: "read",
			strict: true,
			loadMode: "essential",
			execute: async (_toolCallId, _params, _onUpdate, _ctx, signal) => {
				const labels = await listLabels(signal);
				const lines = labels.map(label => `- ${label.name}${label.description ? ` — ${label.description}` : ""}`);
				return textResult(lines.length > 0 ? lines.join("\n") : "The tracker has no labels.");
			},
		},
		{
			name: "issue_samples",
			label: "Issue samples",
			description: resolvePromptAsset("issues/tool-samples.md", samplesDescription).text.trim(),
			parameters: emptySchema,
			approval: "read",
			strict: true,
			loadMode: "essential",
			execute: async (_toolCallId, _params, _onUpdate, _ctx, signal) => {
				const rows = await github.json<{ number: number }[]>(
					cwd,
					[
						"issue",
						"list",
						"--repo",
						repo,
						"--state",
						"all",
						"--limit",
						String(SAMPLE_HISTORY_LIMIT),
						"--json",
						"number",
					],
					signal,
					{ repoProvided: true },
				);
				const picked = selectIssueSamples(
					rows.map(row => row.number),
					options.random,
				);
				if (picked.length === 0) return textResult("The tracker has no issues yet.");
				const issues = await Promise.all(picked.map(number => viewIssue(String(number), signal)));
				return textResult(issues.map(issue => formatIssue(issue, false)).join("\n\n---\n\n"));
			},
		},
		{
			name: "issue_search",
			label: "Issue search",
			description: resolvePromptAsset("issues/tool-search.md", searchDescription).text.trim(),
			parameters: searchSchema,
			approval: "read",
			strict: true,
			loadMode: "essential",
			execute: async (_toolCallId, rawParams, _onUpdate, _ctx, signal) => {
				const params = searchSchema(rawParams);
				if (params instanceof type.errors)
					throw new Error(`issue_search received invalid arguments: ${params.summary}`);
				const rows = await github.json<GhIssueRow[]>(
					cwd,
					[
						"issue",
						"list",
						"--repo",
						repo,
						"--state",
						"all",
						"--search",
						params.query,
						"--limit",
						String(SEARCH_LIMIT),
						"--json",
						ISSUE_ROW_FIELDS,
					],
					signal,
					{ repoProvided: true },
				);
				return textResult(rows.length > 0 ? rows.map(formatIssueRow).join("\n") : "No matching issues.");
			},
		},
		{
			name: "issue_view",
			label: "Issue view",
			description: resolvePromptAsset("issues/tool-view.md", viewDescription).text.trim(),
			parameters: viewSchema,
			approval: "read",
			strict: true,
			loadMode: "essential",
			execute: async (_toolCallId, rawParams, _onUpdate, _ctx, signal) => {
				const params = viewSchema(rawParams);
				if (params instanceof type.errors)
					throw new Error(`issue_view received invalid arguments: ${params.summary}`);
				return textResult(formatIssue(await viewIssue(String(params.number), signal), true));
			},
		},
		{
			name: "issue_publish",
			label: "Publish issue",
			description: resolvePromptAsset("issues/tool-publish.md", publishDescription).text.trim(),
			parameters: publishSchema,
			approval: "write",
			strict: true,
			loadMode: "essential",
			execute: async (_toolCallId, rawParams, _onUpdate, _ctx, signal) => {
				const params = publishSchema(rawParams);
				if (params instanceof type.errors)
					throw new Error(`issue_publish received invalid arguments: ${params.summary}`);
				if (outcome && outcome.kind !== "published") {
					throw new Error("This request already ended without filing; nothing may be published.");
				}
				if (ownerClaim) throw new Error("An existing owner is being recorded; nothing may be published.");
				if (!publication) {
					const attempt = publishOnce(params, signal);
					publication = attempt;
					attempt.then(
						issue => settle({ kind: "published", issue }),
						() => {
							// Retrying a known creation only re-reads its retained reference.
							if (publication === attempt) publication = undefined;
						},
					);
				}
				const issue = await publication;
				return textResult(
					[
						`Published ${issue.url}`,
						`Title: ${issue.title}`,
						`Labels: ${issue.labels.join(", ") || "none"}`,
						"Nothing more may be filed for this request; end your turn with a one-line summary.",
					].join("\n"),
				);
			},
		},
		{
			name: "issue_existing_owner",
			label: "Existing owner",
			description: resolvePromptAsset("issues/tool-existing-owner.md", existingOwnerDescription).text.trim(),
			parameters: existingOwnerSchema,
			approval: "read",
			strict: true,
			loadMode: "essential",
			execute: async (_toolCallId, rawParams, _onUpdate, _ctx, signal) => {
				const params = existingOwnerSchema(rawParams);
				if (params instanceof type.errors) {
					throw new Error(`issue_existing_owner received invalid arguments: ${params.summary}`);
				}
				if (outcome || publication || uncertainCreate || ownerClaim)
					throw new Error("This request already has an outcome.");
				const claim = viewIssue(String(params.number), signal);
				ownerClaim = claim;
				let owner: GhIssueRow;
				try {
					owner = await claim;
				} catch (error) {
					// An owner that could not be read records nothing; the request stays open.
					ownerClaim = undefined;
					throw error;
				}
				settle({
					kind: "existing-owner",
					owner: {
						repo,
						number: owner.number,
						url: owner.url,
						title: owner.title,
						reason: params.reason,
						draft: params.draft,
					},
				});
				return textResult(`Recorded #${owner.number} as the owner. Nothing was posted; end your turn.`);
			},
		},
		createIssueDeclineTool({
			onDecline: reason => settle({ kind: "declined", reason }),
			blocked: () =>
				outcome || publication || uncertainCreate || ownerClaim
					? "This request already has an outcome; it cannot be declined."
					: undefined,
		}),
	];
}
