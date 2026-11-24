import type { MixtureConfigScope } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { getAgentDir, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { MIXTURE_PROVIDER } from "../../moa/provider";
import { type MixtureWebEditor, startMixtureWebEditor } from "../../moa/web-server";
import type { AgentSession } from "../../session/agent-session";
import * as ternPage from "../../tools/browser/tern/user-page";
import * as openUtils from "../../utils/open";
import { refreshStatusLine } from "../builtin-modes";
import type { TuiSlashCommandRuntime } from "../types";
import { errorMessage } from "./parse";

const editors = new WeakMap<AgentSession, MixtureWebEditor>();

export async function launchMixtureWebEditor(ctx: TuiSlashCommandRuntime["ctx"], initialScope: MixtureConfigScope) {
	const { session, sessionManager, settings } = ctx;
	if (session.isDisposed) throw new Error("The invoking session has closed.");
	const sessionId = sessionManager.getSessionId();
	const cwd = sessionManager.getCwd();
	const previous = editors.get(session);
	const editor = startMixtureWebEditor({
		cwd,
		agentDir: session.getMixtureAgentDir() ?? getAgentDir() ?? getProjectDir(),
		registry: session.modelRegistry,
		settings,
		initialScope,
		isCurrent: () =>
			ctx.session === session &&
			ctx.sessionManager === sessionManager &&
			sessionManager.getSessionId() === sessionId &&
			sessionManager.getCwd() === cwd,
		selectedMixture: () => (session.model?.provider === MIXTURE_PROVIDER ? session.model.id : undefined),
		onSaved: message => {
			ctx.showStatus(message);
			refreshStatusLine(ctx);
		},
	});
	previous?.stop();
	editors.set(session, editor);
	if (!previous) {
		session.addDisposer(() => {
			editors.get(session)?.stop();
			editors.delete(session);
		});
	}
	try {
		const page = await ternPage.openTernPage(editor.url, "beside");
		if (page) page.disconnect();
		else openUtils.openPath(editor.url);
	} catch (error) {
		logger.debug("Could not open mixture editor in Tern; trying the system browser", { error: errorMessage(error) });
		openUtils.openPath(editor.url);
	}
	return `Mixture editor available at: ${editor.url}`;
}
