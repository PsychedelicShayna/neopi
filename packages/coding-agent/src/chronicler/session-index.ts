import type { AgentSession } from "../session/agent-session";
import { cfgChroniclerIndexDiagnosticLimit } from "./settings";
import {
	indexConfigFromSettings,
	indexConcurrencyFromSettings,
	resolveViewRoot,
	summaryPolicyFromSettings,
} from "./temporal/config";
import { formatIndexReport } from "./temporal/format";
import { indexChronicle } from "./temporal/indexer";
import { resolveChronicleModelClient } from "./temporal/model";
import { createSummarizer } from "./temporal/summarize";

/** Dispatch an explicitly requested pass; the session scope cannot change after registration. */
export function dispatchSessionChronicleIndex(session: AgentSession): string {
	const manager = session.asyncJobManager;
	if (!manager) throw new Error("Background job manager is unavailable for chronicle index.");
	const ownerId = session.getAgentId();
	if (!ownerId) throw new Error("Could not identify the session owner for chronicle index.");
	const sessionId = session.sessionManager.getSessionId();
	if (!sessionId) throw new Error("Could not identify the current session for chronicle index.");

	const settings = session.settings;
	const agentDir = settings.getAgentDir();
	const root = resolveViewRoot(settings, agentDir);
	const config = indexConfigFromSettings(settings);
	const concurrency = indexConcurrencyFromSettings(settings);
	const diagnosticLimit = cfgChroniclerIndexDiagnosticLimit.get(settings);
	const client = resolveChronicleModelClient(settings, session.modelRegistry, "chronicler-summary", sessionId);
	const summarizer = client ? createSummarizer(client, summaryPolicyFromSettings(settings)) : undefined;
	const jobId = manager.register(
		"chronicle",
		`Index session ${sessionId}`,
		async ({ jobId, signal, reportProgress }) => {
			const report = await indexChronicle({
				agentDir,
				root,
				config,
				sessionId,
				summarizer,
				concurrency,
				signal,
				onProgress: text => reportProgress(text, { async: { state: "running", jobId, type: "chronicle" } }),
			});
			const scope = `Chronicle index for session ${sessionId}: ${report.sessionAtoms} current-session atoms.`;
			const empty = report.sessionAtoms === 0 ? " No nodes were regenerated for this session." : "";
			return `${scope}${empty}\n${formatIndexReport(report, diagnosticLimit)}`;
		},
		{ ownerId },
	);
	return `Chronicle index for session ${sessionId} is running as background job ${jobId}. Results will be delivered automatically when it finishes.`;
}
