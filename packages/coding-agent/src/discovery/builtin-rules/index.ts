import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
/**
 * Bundled default rules shipped with the coding agent.
 *
 * Each markdown source is embedded via `with { type: "text" }` so it survives
 * `bun build --compile` (the compiled binary ships no loose rule files; only
 * the embedded text). The native source/tarball installs read the same modules.
 *
 * Registered by the lowest-priority `builtin-defaults` rule provider so any
 * user/project/tool rule with the same name overrides the bundled copy.
 */
import bundledGoAddCleanup from "./go-add-cleanup.md" with { type: "text" };
import bundledGoBenchLoop from "./go-bench-loop.md" with { type: "text" };
import bundledGoExpPromoted from "./go-exp-promoted.md" with { type: "text" };
import bundledGoIoutil from "./go-ioutil.md" with { type: "text" };
import bundledGoJoinHostport from "./go-join-hostport.md" with { type: "text" };
import bundledGoNewExpr from "./go-new-expr.md" with { type: "text" };
import bundledGoRandV2 from "./go-rand-v2.md" with { type: "text" };
import bundledGoRangeInt from "./go-range-int.md" with { type: "text" };
import bundledRsBoxLeak from "./rs-box-leak.md" with { type: "text" };
import bundledRsFuturePrelude from "./rs-future-prelude.md" with { type: "text" };
import bundledRsLazylock from "./rs-lazylock.md" with { type: "text" };
import bundledRsMatchErgonomics from "./rs-match-ergonomics.md" with { type: "text" };
import bundledRsResultType from "./rs-result-type.md" with { type: "text" };
import bundledTsBareCatch from "./ts-bare-catch.md" with { type: "text" };
import bundledTsImportType from "./ts-import-type.md" with { type: "text" };
import bundledTsNoAny from "./ts-no-any.md" with { type: "text" };
import bundledTsNoDeprecatedLeftovers from "./ts-no-deprecated-leftovers.md" with { type: "text" };
import bundledTsNoDynamicImport from "./ts-no-dynamic-import.md" with { type: "text" };
import bundledTsNoInlineCastAccess from "./ts-no-inline-cast-access.md" with { type: "text" };
import bundledTsNoLocalIsRecord from "./ts-no-local-is-record.md" with { type: "text" };
import bundledTsNoReturnType from "./ts-no-return-type.md" with { type: "text" };
import bundledTsNoTestTimers from "./ts-no-test-timers.md" with { type: "text" };
import bundledTsNoTinyFunctions from "./ts-no-tiny-functions.md" with { type: "text" };
import bundledTsPromiseWithResolvers from "./ts-promise-with-resolvers.md" with { type: "text" };
import bundledTsRedundantClearGuard from "./ts-redundant-clear-guard.md" with { type: "text" };
import bundledTsSetMap from "./ts-set-map.md" with { type: "text" };

/** A bundled rule's stable name and raw markdown (frontmatter + body). */
export interface BuiltinRuleSource {
	name: string;
	content: string;
}

/** All bundled default rules, ordered by name. */
export function getBuiltinRuleSources(cwd?: string): readonly BuiltinRuleSource[] {
	return [
		{
			name: "go-add-cleanup",
			content: resolvePromptAsset("discovery/builtin-rules/go-add-cleanup.md", bundledGoAddCleanup, { cwd }).text,
		},
		{
			name: "go-bench-loop",
			content: resolvePromptAsset("discovery/builtin-rules/go-bench-loop.md", bundledGoBenchLoop, { cwd }).text,
		},
		{
			name: "go-exp-promoted",
			content: resolvePromptAsset("discovery/builtin-rules/go-exp-promoted.md", bundledGoExpPromoted, { cwd }).text,
		},
		{
			name: "go-ioutil",
			content: resolvePromptAsset("discovery/builtin-rules/go-ioutil.md", bundledGoIoutil, { cwd }).text,
		},
		{
			name: "go-join-hostport",
			content: resolvePromptAsset("discovery/builtin-rules/go-join-hostport.md", bundledGoJoinHostport, { cwd })
				.text,
		},
		{
			name: "go-new-expr",
			content: resolvePromptAsset("discovery/builtin-rules/go-new-expr.md", bundledGoNewExpr, { cwd }).text,
		},
		{
			name: "go-rand-v2",
			content: resolvePromptAsset("discovery/builtin-rules/go-rand-v2.md", bundledGoRandV2, { cwd }).text,
		},
		{
			name: "go-range-int",
			content: resolvePromptAsset("discovery/builtin-rules/go-range-int.md", bundledGoRangeInt, { cwd }).text,
		},
		{
			name: "rs-box-leak",
			content: resolvePromptAsset("discovery/builtin-rules/rs-box-leak.md", bundledRsBoxLeak, { cwd }).text,
		},
		{
			name: "rs-future-prelude",
			content: resolvePromptAsset("discovery/builtin-rules/rs-future-prelude.md", bundledRsFuturePrelude, { cwd })
				.text,
		},
		{
			name: "rs-lazylock",
			content: resolvePromptAsset("discovery/builtin-rules/rs-lazylock.md", bundledRsLazylock, { cwd }).text,
		},
		{
			name: "rs-match-ergonomics",
			content: resolvePromptAsset("discovery/builtin-rules/rs-match-ergonomics.md", bundledRsMatchErgonomics, {
				cwd,
			}).text,
		},
		{
			name: "rs-result-type",
			content: resolvePromptAsset("discovery/builtin-rules/rs-result-type.md", bundledRsResultType, { cwd }).text,
		},
		{
			name: "ts-bare-catch",
			content: resolvePromptAsset("discovery/builtin-rules/ts-bare-catch.md", bundledTsBareCatch, { cwd }).text,
		},
		{
			name: "ts-import-type",
			content: resolvePromptAsset("discovery/builtin-rules/ts-import-type.md", bundledTsImportType, { cwd }).text,
		},
		{
			name: "ts-no-any",
			content: resolvePromptAsset("discovery/builtin-rules/ts-no-any.md", bundledTsNoAny, { cwd }).text,
		},
		{
			name: "ts-no-deprecated-leftovers",
			content: resolvePromptAsset(
				"discovery/builtin-rules/ts-no-deprecated-leftovers.md",
				bundledTsNoDeprecatedLeftovers,
				{ cwd },
			).text,
		},
		{
			name: "ts-no-dynamic-import",
			content: resolvePromptAsset("discovery/builtin-rules/ts-no-dynamic-import.md", bundledTsNoDynamicImport, {
				cwd,
			}).text,
		},
		{
			name: "ts-no-inline-cast-access",
			content: resolvePromptAsset(
				"discovery/builtin-rules/ts-no-inline-cast-access.md",
				bundledTsNoInlineCastAccess,
				{ cwd },
			).text,
		},
		{
			name: "ts-no-local-is-record",
			content: resolvePromptAsset("discovery/builtin-rules/ts-no-local-is-record.md", bundledTsNoLocalIsRecord, {
				cwd,
			}).text,
		},
		{
			name: "ts-no-return-type",
			content: resolvePromptAsset("discovery/builtin-rules/ts-no-return-type.md", bundledTsNoReturnType, { cwd })
				.text,
		},
		{
			name: "ts-no-test-timers",
			content: resolvePromptAsset("discovery/builtin-rules/ts-no-test-timers.md", bundledTsNoTestTimers, { cwd })
				.text,
		},
		{
			name: "ts-no-tiny-functions",
			content: resolvePromptAsset("discovery/builtin-rules/ts-no-tiny-functions.md", bundledTsNoTinyFunctions, {
				cwd,
			}).text,
		},
		{
			name: "ts-promise-with-resolvers",
			content: resolvePromptAsset(
				"discovery/builtin-rules/ts-promise-with-resolvers.md",
				bundledTsPromiseWithResolvers,
				{ cwd },
			).text,
		},
		{
			name: "ts-redundant-clear-guard",
			content: resolvePromptAsset(
				"discovery/builtin-rules/ts-redundant-clear-guard.md",
				bundledTsRedundantClearGuard,
				{ cwd },
			).text,
		},
		{
			name: "ts-set-map",
			content: resolvePromptAsset("discovery/builtin-rules/ts-set-map.md", bundledTsSetMap, { cwd }).text,
		},
	];
}
