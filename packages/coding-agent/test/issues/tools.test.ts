import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CustomTool } from "../../src/extensibility/custom-tools/types";
import * as targetInventory from "../../src/issues/target-inventory";
import {
	createIssueAuthorTools,
	createIssueTargetTool,
	type IssuePublicationState,
	type IssueFilingOutcome,
	type IssueTargetSelection,
} from "../../src/issues/tools";
import type { ForgeCliResult } from "../../src/utils/forge-cli";
import { github } from "../../src/utils/github";

const REPO = "github.com/Owner/Project";
const OTHER_REPO = "ghe.example.test/Owner/Project";
const CHECKOUT: targetInventory.IssueCheckout = {
	path: "/tmp/npi-issue-tool-checkout",
	repo: REPO,
	linkedWorktree: false,
	source: "override",
};
const TITLE = "bug: preserve the operator's request";
const BODY = "## Report\n\nThe submitted draft, including uncertainty.\n";
const LABELS = ["bug", "needs-triage"];
const STARTED_AT = Date.parse("2026-10-18T12:00:00Z");
const ACTUAL_ISSUE = {
	number: 305,
	title: "Recorded title",
	url: "https://github.com/Owner/Project/issues/305",
	createdAt: "2026-10-18T12:00:05Z",
	body: "## Actual submitted body\n\nGitHub's recorded body, not the draft.\n",
	labels: [{ name: "bug" }, { name: "priority: p1" }],
};

function spyDependencies() {
	return {
		json: vi.spyOn(github, "json").mockRejectedValue(new Error("Unexpected GitHub JSON request")),
		run: vi.spyOn(github, "run").mockRejectedValue(new Error("Unexpected GitHub mutation")),
		verify: vi.spyOn(targetInventory, "verifyIssueCheckout").mockResolvedValue(true),
	};
}

function repository(
	repo = REPO,
	checkouts: targetInventory.IssueCheckout[] = [{ ...CHECKOUT, repo }],
): targetInventory.IssueRepoCandidate {
	return { repo, checkouts };
}

function inventory(...repositories: targetInventory.IssueRepoCandidate[]): targetInventory.IssueTargetInventory {
	return { foreground: { cwd: CHECKOUT.path, repoRoot: CHECKOUT.path, repo: REPO }, repositories, warnings: [] };
}

function invoke(tool: CustomTool, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
	return tool.execute("issue-tool-test", params, undefined, {} as never, undefined);
}

function author() {
	const outcomes: IssueFilingOutcome[] = [];
	const publicationStates: IssuePublicationState[] = [];
	const onOutcome = vi.fn((outcome: IssueFilingOutcome) => outcomes.push(outcome));
	const tools = createIssueAuthorTools({
		repo: REPO,
		checkout: CHECKOUT,
		startedAt: STARTED_AT,
		onOutcome,
		onPublication: state => publicationStates.push(state),
	});
	const named = (name: string): CustomTool => {
		const tool = tools.find(entry => entry.name === name);
		if (!tool) throw new Error(`Missing issue tool: ${name}`);
		return tool;
	};
	return {
		publish: named("issue_publish"),
		existingOwner: named("issue_existing_owner"),
		decline: named("issue_decline"),
		outcomes,
		publicationStates,
		onOutcome,
	};
}

function publishParams(): Record<string, unknown> {
	return { title: TITLE, body: BODY, labels: LABELS };
}

const actualPublished: Extract<IssueFilingOutcome, { kind: "published" }> = {
	kind: "published",
	issue: {
		repo: REPO,
		number: ACTUAL_ISSUE.number,
		url: ACTUAL_ISSUE.url,
		title: ACTUAL_ISSUE.title,
		body: ACTUAL_ISSUE.body,
		labels: ACTUAL_ISSUE.labels.map(label => label.name),
	},
};

const ownIssueListArgs = [
	"issue",
	"list",
	"--repo",
	REPO,
	"--state",
	"all",
	"--author",
	"@me",
	"--limit",
	"30",
	"--json",
	"number,title,url,state,createdAt,labels,body",
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("issue_target", () => {
	it("rejects a repository outside the discovered inventory", async () => {
		const { verify, run, json } = spyDependencies();
		const onSelect = vi.fn();
		const tool = createIssueTargetTool({ inventory: inventory(repository()), onSelect });

		await expect(invoke(tool, { repo: OTHER_REPO, reason: "requested project" })).rejects.toThrow(
			"not in the inventory",
		);
		expect(onSelect).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(json).not.toHaveBeenCalled();
	});

	it("rejects repositories with issues disabled", async () => {
		const { verify } = spyDependencies();
		const onSelect = vi.fn();
		const tool = createIssueTargetTool({ inventory: inventory({ ...repository(), issuesEnabled: false }), onSelect });

		await expect(invoke(tool, { repo: REPO, reason: "requested project" })).rejects.toThrow("issues disabled");
		expect(onSelect).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
	});

	it("rejects archived repositories before selecting or starting authoring", async () => {
		const { verify, run } = spyDependencies();
		const onSelect = vi.fn();
		const tool = createIssueTargetTool({ inventory: inventory({ ...repository(), archived: true }), onSelect });
		await expect(invoke(tool, { repo: REPO, reason: "explicitly requested project" })).rejects.toThrow("archived");
		expect(onSelect).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects a target without a local checkout instead of cloning it", async () => {
		const { verify, run } = spyDependencies();
		const onSelect = vi.fn();
		const tool = createIssueTargetTool({ inventory: inventory(repository(REPO, [])), onSelect });

		await expect(invoke(tool, { repo: REPO, reason: "requested project" })).rejects.toThrow("has no local checkout");
		expect(onSelect).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects a checkout that no longer verifies against the selected identity", async () => {
		const { verify } = spyDependencies();
		verify.mockResolvedValue(false);
		const onSelect = vi.fn();
		const tool = createIssueTargetTool({ inventory: inventory(repository()), onSelect });

		await expect(invoke(tool, { repo: REPO, reason: "requested project" })).rejects.toThrow("no longer has a remote");
		expect(verify).toHaveBeenCalledWith(CHECKOUT, REPO, undefined);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("keeps the first selection immutable while allowing a repeat of the same identity", async () => {
		const { verify } = spyDependencies();
		const onSelect = vi.fn();
		const first = repository();
		const tool = createIssueTargetTool({ inventory: inventory(first, repository(OTHER_REPO)), onSelect });

		await invoke(tool, { repo: REPO.toLowerCase(), reason: "the operator named Project" });
		await invoke(tool, { repo: REPO, reason: "repeat" });
		await expect(invoke(tool, { repo: OTHER_REPO, reason: "switch" })).rejects.toThrow("cannot be changed");
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith({
			candidate: first,
			checkout: CHECKOUT,
			reason: "the operator named Project",
		});
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it("rejects a competing concurrent target after checkout verification resolves", async () => {
		const { verify } = spyDependencies();
		const verification = Promise.withResolvers<boolean>();
		verify.mockImplementation(() => verification.promise);
		const selections: IssueTargetSelection[] = [];
		const tool = createIssueTargetTool({
			inventory: inventory(repository(), repository(OTHER_REPO)),
			onSelect: selection => selections.push(selection),
		});
		const first = invoke(tool, { repo: REPO, reason: "first" });
		const competing = invoke(tool, { repo: OTHER_REPO, reason: "second" });
		verification.resolve(true);
		const results = await Promise.allSettled([first, competing]);

		expect(results[0]?.status).toBe("fulfilled");
		expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
		expect(selections).toHaveLength(1);
		expect(selections[0]?.candidate.repo).toBe(REPO);
	});
});

describe("issue_publish", () => {
	it("rejects unknown labels without attempting issue creation", async () => {
		const { json, run, verify } = spyDependencies();
		json.mockResolvedValueOnce([{ name: "bug" }]);
		const { publish, outcomes } = author();

		await expect(invoke(publish, { title: TITLE, body: BODY, labels: ["invented-label"] })).rejects.toThrow(
			"Unknown labels",
		);
		expect(run).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect(outcomes).toEqual([]);
	});

	it("pins creation to the target, sends body-file and labels, and reports the recorded issue", async () => {
		const { json, run, verify } = spyDependencies();
		json.mockResolvedValueOnce(LABELS.map(name => ({ name }))).mockResolvedValueOnce(ACTUAL_ISSUE);
		run.mockImplementation(async (_cwd, args) => {
			const bodyFile = args[args.indexOf("--body-file") + 1];
			expect(await Bun.file(bodyFile).text()).toBe(BODY);
			return { exitCode: 0, stdout: `${ACTUAL_ISSUE.url}\n`, stderr: "" };
		});
		const { publish, outcomes } = author();
		const result = await invoke(publish, publishParams());

		expect(verify).toHaveBeenCalledWith(CHECKOUT, REPO, undefined);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith(
			CHECKOUT.path,
			[
				"issue",
				"create",
				"--repo",
				REPO,
				"--title",
				TITLE,
				"--body-file",
				expect.any(String),
				"--label",
				"bug",
				"--label",
				"needs-triage",
			],
			undefined,
			{ repoProvided: true },
		);
		expect(json).toHaveBeenLastCalledWith(
			CHECKOUT.path,
			[
				"issue",
				"view",
				ACTUAL_ISSUE.url,
				"--repo",
				REPO,
				"--json",
				"number,title,url,state,createdAt,body,labels,author,comments",
			],
			undefined,
			{ repoProvided: true },
		);
		expect(outcomes).toEqual([actualPublished]);
		expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining(ACTUAL_ISSUE.url) });
		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringContaining("Labels: bug, priority: p1"),
		});
	});

	it("shares one creation and one outcome across concurrent and repeated publish calls", async () => {
		const { json, run } = spyDependencies();
		json.mockResolvedValueOnce(LABELS.map(name => ({ name }))).mockResolvedValueOnce(ACTUAL_ISSUE);
		const entered = Promise.withResolvers<void>();
		const creation = Promise.withResolvers<ForgeCliResult>();
		run.mockImplementation(() => {
			entered.resolve();
			return creation.promise;
		});
		const { publish, outcomes, onOutcome } = author();
		const first = invoke(publish, publishParams());
		await entered.promise;
		const second = invoke(publish, publishParams());
		creation.resolve({ exitCode: 0, stdout: ACTUAL_ISSUE.url, stderr: "" });
		const [firstResult, secondResult] = await Promise.all([first, second]);
		const repeatedResult = await invoke(publish, publishParams());

		expect(firstResult).toEqual(secondResult);
		expect(repeatedResult).toEqual(firstResult);
		expect(run).toHaveBeenCalledTimes(1);
		expect(onOutcome).toHaveBeenCalledTimes(1);
		expect(outcomes).toEqual([actualPublished]);
	});

	it("retries only the read after a successful create whose confirmation fails", async () => {
		const { json, run } = spyDependencies();
		let reads = 0;
		json.mockImplementation(async (_cwd, args) => {
			if (args[0] === "label") return LABELS.map(name => ({ name })) as never;
			if (args[0] === "issue" && args[1] === "view") {
				if (++reads === 1) throw new Error("temporary confirmation failure");
				return ACTUAL_ISSUE as never;
			}
			throw new Error("Unexpected GitHub request");
		});
		run.mockResolvedValue({ exitCode: 0, stdout: ACTUAL_ISSUE.url, stderr: "" });
		const { publish, decline, existingOwner, outcomes } = author();
		await expect(invoke(publish, publishParams())).rejects.toThrow("temporary confirmation failure");
		await expect(invoke(decline, { reason: "cancel after creation" })).rejects.toThrow("already has an outcome");
		await expect(
			invoke(existingOwner, { number: 7, reason: "different owner", draft: "amend instead" }),
		).rejects.toThrow("already has an outcome");
		await invoke(publish, publishParams());
		expect(run).toHaveBeenCalledTimes(1);
		expect(outcomes).toEqual([actualPublished]);
	});

	it("reconciles an uncertain create again after the lookup fails without creating twice", async () => {
		const { json, run } = spyDependencies();
		let lookups = 0;
		json.mockImplementation(async (_cwd, args) => {
			if (args[0] === "label") return LABELS.map(name => ({ name })) as never;
			if (args[0] === "issue" && args[1] === "list") {
				if (++lookups === 1) throw new Error("temporary reconciliation failure");
				return [{ ...ACTUAL_ISSUE, title: TITLE, body: BODY }] as never;
			}
			if (args[0] === "issue" && args[1] === "view") return ACTUAL_ISSUE as never;
			throw new Error("Unexpected GitHub request");
		});
		run.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "connection dropped after sending" });
		const { publish, outcomes } = author();
		await expect(invoke(publish, publishParams())).rejects.toThrow("temporary reconciliation failure");
		await invoke(publish, publishParams());
		expect(run).toHaveBeenCalledTimes(1);
		expect(outcomes).toEqual([actualPublished]);
	});

	it.each(["nonzero exit", "thrown error"])(
		"adopts a just-created own issue after %s without creating twice",
		async failure => {
			const { json, run } = spyDependencies();
			const adopted = { ...ACTUAL_ISSUE, title: TITLE };
			json
				.mockResolvedValueOnce(LABELS.map(name => ({ name })))
				.mockResolvedValueOnce([
					{ ...adopted, body: BODY, number: 1, createdAt: "2026-10-17T12:00:00Z" },
					{ ...adopted, body: BODY, number: 2, title: "another request" },
					// Same title and time but a different body: an unrelated filing, never adopted.
					{ ...adopted, body: "Someone else's report.", number: 3 },
					{ ...adopted, body: BODY.replace(/\n/g, "\r\n") },
				])
				.mockResolvedValueOnce(adopted);
			if (failure === "thrown error") run.mockRejectedValueOnce(new Error("connection dropped after sending"));
			else run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "connection dropped after sending" });
			const { publish, outcomes } = author();
			const result = await invoke(publish, publishParams());
			await invoke(publish, publishParams());

			expect(run).toHaveBeenCalledTimes(1);
			const lookups = json.mock.calls.filter(([, args]) => args[0] === "issue" && args[1] === "list");
			expect(lookups).toHaveLength(1);
			for (const call of lookups) {
				expect(call).toEqual([CHECKOUT.path, ownIssueListArgs, undefined, { repoProvided: true }]);
			}
			expect(json).toHaveBeenLastCalledWith(
				CHECKOUT.path,
				[
					"issue",
					"view",
					String(adopted.number),
					"--repo",
					REPO,
					"--json",
					"number,title,url,state,createdAt,body,labels,author,comments",
				],
				undefined,
				{ repoProvided: true },
			);
			expect(outcomes).toEqual([{ ...actualPublished, issue: { ...actualPublished.issue, title: TITLE } }]);
			expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining(adopted.url) });
		},
	);

	it("keeps an absent reconciliation result uncertain and never repeats the create", async () => {
		const { json, run } = spyDependencies();
		json
			.mockResolvedValueOnce(LABELS.map(name => ({ name })))
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ ...ACTUAL_ISSUE, title: TITLE, body: BODY }])
			.mockResolvedValueOnce(ACTUAL_ISSUE);
		run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "request outcome unknown" });
		const { publish, decline, existingOwner, outcomes, publicationStates } = author();
		await expect(invoke(publish, publishParams())).rejects.toThrow("has not been confirmed");
		expect(publicationStates).toEqual([{ kind: "uncertain", repo: REPO, title: TITLE }]);
		expect(outcomes).toEqual([]);
		await expect(invoke(decline, { reason: "cancel while uncertain" })).rejects.toThrow("already has an outcome");
		await expect(invoke(existingOwner, { number: 7, reason: "owner", draft: "draft" })).rejects.toThrow(
			"already has an outcome",
		);
		await expect(invoke(publish, publishParams())).rejects.toThrow("has not been confirmed");
		await invoke(publish, { ...publishParams(), title: "changed retry title", body: "changed retry body" });
		expect(run).toHaveBeenCalledTimes(1);
		expect(outcomes).toEqual([actualPublished]);
	});

	it("never adopts a same-title issue before creating", async () => {
		const { json, run } = spyDependencies();
		json.mockResolvedValueOnce(LABELS.map(name => ({ name }))).mockResolvedValueOnce(ACTUAL_ISSUE);
		run.mockResolvedValueOnce({ exitCode: 0, stdout: ACTUAL_ISSUE.url, stderr: "" });
		const { publish } = author();
		await invoke(publish, publishParams());

		expect(run).toHaveBeenCalledTimes(1);
		expect(json.mock.calls.some(([, args]) => args.includes("@me"))).toBe(false);
	});
});

describe("terminal outcomes", () => {
	it("refuses a publish issued alongside an existing-owner report", async () => {
		const { json, run } = spyDependencies();
		const ownerRead = Promise.withResolvers<unknown>();
		json.mockImplementationOnce(() => ownerRead.promise as never);
		const { existingOwner, publish, outcomes } = author();
		// One parallel tool batch: the owner report starts first and is still reading.
		const owner = invoke(existingOwner, { number: ACTUAL_ISSUE.number, reason: "owns it", draft: "draft" });
		const publishing = invoke(publish, publishParams());
		ownerRead.resolve(ACTUAL_ISSUE);
		const [ownerResult, publishResult] = await Promise.allSettled([owner, publishing]);

		expect(ownerResult.status).toBe("fulfilled");
		expect(publishResult.status).toBe("rejected");
		expect(run).not.toHaveBeenCalled();
		expect(outcomes.map(outcome => outcome.kind)).toEqual(["existing-owner"]);
	});

	it("refuses an existing-owner report issued alongside a publish", async () => {
		const { json, run } = spyDependencies();
		json.mockResolvedValueOnce(LABELS.map(name => ({ name }))).mockResolvedValueOnce(ACTUAL_ISSUE);
		run.mockResolvedValueOnce({ exitCode: 0, stdout: ACTUAL_ISSUE.url, stderr: "" });
		const { existingOwner, publish, outcomes } = author();
		const publishing = invoke(publish, publishParams());
		const owner = invoke(existingOwner, { number: ACTUAL_ISSUE.number, reason: "owns it", draft: "draft" });
		const [publishResult, ownerResult] = await Promise.allSettled([publishing, owner]);

		expect(publishResult.status).toBe("fulfilled");
		expect(ownerResult.status).toBe("rejected");
		expect(outcomes).toEqual([actualPublished]);
	});

	it("declines without filing and then refuses publication", async () => {
		const { json, run } = spyDependencies();
		const { decline, publish, outcomes } = author();
		await invoke(decline, { reason: "the operator said not to file" });

		expect(outcomes).toEqual([{ kind: "declined", reason: "the operator said not to file" }]);
		await expect(invoke(publish, publishParams())).rejects.toThrow("ended without filing");
		expect(json).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses to decline after publication", async () => {
		const { json, run } = spyDependencies();
		json.mockResolvedValueOnce(LABELS.map(name => ({ name }))).mockResolvedValueOnce(ACTUAL_ISSUE);
		run.mockResolvedValueOnce({ exitCode: 0, stdout: ACTUAL_ISSUE.url, stderr: "" });
		const { decline, publish, outcomes } = author();
		await invoke(publish, publishParams());

		await expect(invoke(decline, { reason: "changed mind" })).rejects.toThrow("already has an outcome");
		expect(outcomes).toEqual([actualPublished]);
	});
});

describe("issue_existing_owner", () => {
	it("records the proposed amendment without posting and prevents subsequent publication", async () => {
		const { json, run } = spyDependencies();
		json.mockResolvedValueOnce(ACTUAL_ISSUE);
		const { existingOwner, publish, outcomes } = author();
		const draft = "Proposed additional report for the operator to review.";
		const reason = "The existing issue already owns the same failure.";
		await invoke(existingOwner, { number: ACTUAL_ISSUE.number, reason, draft });

		expect(outcomes).toEqual([
			{
				kind: "existing-owner",
				owner: {
					repo: REPO,
					number: ACTUAL_ISSUE.number,
					url: ACTUAL_ISSUE.url,
					title: ACTUAL_ISSUE.title,
					reason,
					draft,
				},
			},
		]);
		expect(json).toHaveBeenCalledTimes(1);
		expect(json.mock.calls[0]?.[1].slice(0, 3)).toEqual(["issue", "view", String(ACTUAL_ISSUE.number)]);
		expect(run).not.toHaveBeenCalled();
		await expect(invoke(publish, publishParams())).rejects.toThrow("ended without filing");
		expect(json).toHaveBeenCalledTimes(1);
		expect(run).not.toHaveBeenCalled();
	});
});
