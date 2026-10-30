/**
 * Multi-viewer relay for one daemon-hosted `rpc-ui` session.
 *
 * The child is the ordinary single-client RPC runtime NeoCode drives over
 * stdio. The relay turns it into a shared session without changing the frame
 * vocabulary, so any rpc-ui client can be a viewer:
 *
 * - Commands carrying an `id` are namespaced per viewer before reaching the
 *   child; the `response` goes back only to the asker, with its id restored.
 *   A response whose asker detached is dropped, never broadcast. Answers to
 *   child-initiated frames (host tool / URI results) keep their ids.
 * - Every other child frame is broadcast.
 * - Interactions (extension UI questions, tool approvals, plan proposals) go to
 *   every viewer. The first answer settles it; later answers get an
 *   `already_answered` error response; the other viewers receive the protocol's
 *   own cancel frame so their dialog closes.
 * - Snapshot cut: the child's `snapshot_session_journal` handler emits
 *   `journal_state{reason:"snapshot"}` (plus `message_start{snapshot:true}` for an
 *   in-flight message) in-stream before its response. Snapshots are serialized;
 *   those frames go only to the viewer that asked, and an attaching viewer's live
 *   stream starts right after its marker: no frame twice, none missed, and the
 *   viewers already attached see nothing extra.
 * - Protocol negotiation is per viewer: the daemon keeps the child on v2 and
 *   decodes its chunks; the relay answers `negotiate_protocol` itself and each
 *   viewer's transport re-encodes frames at the version that viewer chose.
 * - A viewer may send requests from the moment it attaches (NeoCode negotiates
 *   as soon as it sees `ready`); only the broadcast set waits for the cut.
 * - Host tools and host URI schemes are connection-owned (#593): calls go to the
 *   viewer that registered them, and its registration is withdrawn on detach.
 *
 * The daemon holds the child's stdin for the child's whole life, so the last
 * viewer detaching never reaches rpc-ui's EOF teardown.
 */

export interface RelayViewer {
	readonly id: string;
	send(frame: Record<string, unknown>): void;
	/** Switch this viewer's outbound framing after it negotiated a protocol version. */
	setProtocolVersion(version: 1 | 2): void;
}

export type ChildWriter = (frame: Record<string, unknown>) => void;

/** Child frames that open an interaction, and the answer frame each expects. */
const INTERACTION_ANSWERS: Record<string, string> = {
	extension_ui_request: "extension_ui_response",
	tool_approval_request: "tool_approval_response",
	plan_proposal_request: "plan_proposal_response",
};
const ANSWER_TYPES = new Set(Object.values(INTERACTION_ANSWERS));
/** extension_ui methods that only notify; nothing answers them. */
const UI_NOTIFICATIONS = new Set([
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
	"open_url",
	"cancel",
]);
/** Viewer frames that answer a child-initiated request by its id. */
const CHILD_REPLY_TYPES = new Set(["host_tool_result", "host_tool_update", "host_uri_result"]);
const HOST_TOOL_FRAMES = new Set(["host_tool_call", "host_tool_cancel"]);
const HOST_URI_FRAMES = new Set(["host_uri_request"]);

interface Interaction {
	type: string;
	frame: Record<string, unknown>;
}

/** One serialized journal snapshot: a viewer attaching, or a viewer's own request. */
interface Snapshot {
	viewer: RelayViewer;
	requestId: string;
	/** Present for a viewer's own `snapshot_session_journal`; absent for an attach. */
	clientId?: unknown;
	/** The viewer's `daemon.attach` request id, echoed on the attach response. */
	attachId?: unknown;
	frame: Record<string, unknown>;
	/** The child's `journal_state` snapshot marker has been seen. */
	cut: boolean;
	/** The viewer left before the snapshot completed. */
	gone: boolean;
}

export class SessionRelay {
	readonly #writeChild: ChildWriter;
	/** Broadcast set: viewers past their snapshot cut. */
	readonly #viewers = new Map<string, RelayViewer>();
	/** Every connected viewer, attaching or attached; requests and responses use this. */
	readonly #known = new Map<string, RelayViewer>();
	readonly #routes = new Map<string, { viewerId: string; id: unknown }>();
	readonly #queries = new Map<string, (frame: Record<string, unknown>) => void>();
	readonly #interactions = new Map<string, Interaction>();
	readonly #snapshots: Snapshot[] = [];
	#hostToolOwner: string | undefined;
	#hostUriOwner: string | undefined;
	#ready: Record<string, unknown> | undefined;
	#nextRequest = 0;
	lastActivity = Date.now();
	streaming = false;

	constructor(writeChild: ChildWriter) {
		this.#writeChild = writeChild;
	}

	get viewerCount(): number {
		return this.#viewers.size;
	}

	/** Open interactions waiting for an answer: the hub's "needs input". */
	get pendingInteractions(): number {
		return this.#interactions.size;
	}

	/** Attach a viewer; its stream starts at an exact snapshot cut. */
	attach(viewer: RelayViewer, attachId?: unknown): void {
		this.#known.set(viewer.id, viewer);
		if (this.#ready) viewer.send(this.#ready);
		this.#enqueueSnapshot(viewer, undefined, {}, attachId);
	}

	detach(viewerId: string): void {
		this.#viewers.delete(viewerId);
		this.#known.delete(viewerId);
		for (let i = this.#snapshots.length - 1; i >= 0; i--) {
			const snapshot = this.#snapshots[i]!;
			if (snapshot.viewer.id !== viewerId) continue;
			// The head is already with the child: let it finish, then discard.
			if (i === 0) snapshot.gone = true;
			else this.#snapshots.splice(i, 1);
		}
		if (this.#hostToolOwner === viewerId) {
			this.#hostToolOwner = undefined;
			void this.query({ type: "set_host_tools", tools: [] });
		}
		if (this.#hostUriOwner === viewerId) {
			this.#hostUriOwner = undefined;
			void this.query({ type: "set_host_uri_schemes", schemes: [] });
		}
	}

	/** Daemon-internal request (hub metadata); never visible to viewers. */
	query(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = this.#requestId("query");
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		this.#queries.set(id, resolve);
		this.#writeChild({ ...frame, id });
		return promise;
	}

	/** The child exited: fail internal queries. */
	close(): void {
		for (const resolve of this.#queries.values())
			resolve({ type: "response", success: false, error: "session exited" });
		this.#queries.clear();
	}

	/** A frame from a viewer. */
	fromViewer(viewerId: string, frame: Record<string, unknown>): void {
		this.lastActivity = Date.now();
		const viewer = this.#known.get(viewerId);
		if (!viewer) return;
		const type = typeof frame.type === "string" ? frame.type : "";
		if (ANSWER_TYPES.has(type)) {
			this.#answer(viewer, type, frame);
			return;
		}
		if (type === "negotiate_protocol") {
			// Answered here: the child is shared, so each viewer's framing is its own.
			if (frame.protocolVersion !== 2) {
				viewer.send({
					type: "response",
					command: "negotiate_protocol",
					id: frame.id,
					success: false,
					error: `Unsupported RPC protocol version: ${String(frame.protocolVersion)}`,
				});
				return;
			}
			viewer.send({
				type: "response",
				command: "negotiate_protocol",
				id: frame.id,
				success: true,
				data: { protocolVersion: 2 },
			});
			viewer.setProtocolVersion(2);
			return;
		}
		if (type === "snapshot_session_journal" && frame.id !== undefined) {
			this.#enqueueSnapshot(viewer, frame.id, frame);
			return;
		}
		if (CHILD_REPLY_TYPES.has(type) || frame.id === undefined) {
			this.#writeChild(frame);
			return;
		}
		if (type === "set_host_tools") this.#hostToolOwner = viewerId;
		if (type === "set_host_uri_schemes") this.#hostUriOwner = viewerId;
		const routed = this.#requestId(viewerId);
		this.#routes.set(routed, { viewerId, id: frame.id });
		this.#writeChild({ ...frame, id: routed });
	}

	/** A frame from the child. */
	fromChild(frame: Record<string, unknown>): void {
		this.lastActivity = Date.now();
		const type = typeof frame.type === "string" ? frame.type : "";
		if (type === "ready") {
			// Attaching viewers too: one that attached before the child started must still get it.
			this.#ready = frame;
			for (const viewer of this.#known.values()) viewer.send(frame);
			return;
		}
		if (type === "response" && typeof frame.id === "string" && this.#routeResponse(frame.id, frame)) return;

		const snapshot = this.#snapshots[0];
		if (snapshot && !snapshot.cut && type === "journal_state" && frame.reason === "snapshot") {
			snapshot.cut = true;
			if (!snapshot.gone) snapshot.viewer.send(frame);
			return;
		}
		if (
			snapshot?.cut &&
			frame.snapshot === true &&
			(type === "message_start" || type === "tool_execution_start" || type === "tool_execution_update")
		) {
			if (!snapshot.gone) snapshot.viewer.send(frame);
			return;
		}

		this.#track(type, frame);
		if (HOST_TOOL_FRAMES.has(type) || HOST_URI_FRAMES.has(type)) {
			const owner = HOST_TOOL_FRAMES.has(type) ? this.#hostToolOwner : this.#hostUriOwner;
			if (owner !== undefined) this.#known.get(owner)?.send(frame);
			return;
		}
		this.#broadcast(frame);
		// An attacher past its cut receives live frames before it joins the broadcast set.
		if (snapshot?.cut && !snapshot.gone && snapshot.clientId === undefined) snapshot.viewer.send(frame);
	}

	#routeResponse(id: string, frame: Record<string, unknown>): boolean {
		const query = this.#queries.get(id);
		if (query) {
			this.#queries.delete(id);
			query(frame);
			return true;
		}
		const snapshot = this.#snapshots[0];
		if (snapshot && snapshot.requestId === id) {
			this.#finishSnapshot(snapshot, frame);
			return true;
		}
		const route = this.#routes.get(id);
		if (!route) return false;
		this.#routes.delete(id);
		// Dropped when the asker has detached: a response is never broadcast.
		this.#known.get(route.viewerId)?.send({ ...frame, id: route.id });
		return true;
	}

	#enqueueSnapshot(viewer: RelayViewer, clientId: unknown, frame: Record<string, unknown>, attachId?: unknown): void {
		this.#snapshots.push({
			viewer,
			requestId: this.#requestId("snapshot"),
			clientId,
			attachId,
			frame,
			cut: false,
			gone: false,
		});
		if (this.#snapshots.length === 1) this.#startSnapshot();
	}

	#startSnapshot(): void {
		const snapshot = this.#snapshots[0];
		if (!snapshot) return;
		this.#writeChild({ ...snapshot.frame, type: "snapshot_session_journal", id: snapshot.requestId });
	}

	#finishSnapshot(snapshot: Snapshot, response: Record<string, unknown>): void {
		this.#snapshots.shift();
		if (!snapshot.gone) {
			const { viewer } = snapshot;
			if (snapshot.clientId !== undefined) {
				viewer.send({ ...response, id: snapshot.clientId });
			} else {
				viewer.send({
					type: "response",
					command: "daemon.attach",
					id: snapshot.attachId,
					success: response.success !== false,
					data: response.data ?? null,
					...(response.error === undefined ? {} : { error: response.error }),
				});
				// Open interactions predate the cut; the attacher must be able to see and answer them.
				for (const interaction of this.#interactions.values()) viewer.send(interaction.frame);
				this.#viewers.set(viewer.id, viewer);
			}
		}
		this.#startSnapshot();
	}

	#track(type: string, frame: Record<string, unknown>): void {
		if (type === "agent_start") this.streaming = true;
		else if (type === "agent_end" && frame.willContinue !== true) this.streaming = false;
		if (type in INTERACTION_ANSWERS) {
			if (type === "extension_ui_request" && frame.method === "cancel") {
				if (typeof frame.targetId === "string") this.#interactions.delete(frame.targetId);
			} else if (!(type === "extension_ui_request" && UI_NOTIFICATIONS.has(String(frame.method)))) {
				this.#interactions.set(String(frame.id), { type, frame });
			}
		} else if (type === "tool_approval_cancel" && typeof frame.targetId === "string") {
			this.#interactions.delete(frame.targetId);
		} else if (type === "plan_proposal_cancel") {
			this.#interactions.delete(String(frame.id));
		}
	}

	#answer(viewer: RelayViewer, type: string, frame: Record<string, unknown>): void {
		const id = String(frame.id);
		const interaction = this.#interactions.get(id);
		if (!interaction || INTERACTION_ANSWERS[interaction.type] !== type) {
			viewer.send({
				type: "response",
				command: type,
				id,
				success: false,
				code: "already_answered",
				error: "This request was already answered or cancelled",
			});
			return;
		}
		this.#interactions.delete(id);
		this.#writeChild(frame);
		const close = this.#closeFrame(interaction, id);
		for (const other of this.#viewers.values()) if (other.id !== viewer.id) other.send(close);
	}

	/** The protocol's own close frame for an interaction another viewer answered. */
	#closeFrame(interaction: Interaction, id: string): Record<string, unknown> {
		switch (interaction.type) {
			case "tool_approval_request":
				return { type: "tool_approval_cancel", id: this.#requestId("settled"), targetId: id };
			case "plan_proposal_request":
				return { type: "plan_proposal_cancel", id, reason: "answered_by_another_viewer" };
			default:
				return { type: "extension_ui_request", id: this.#requestId("settled"), method: "cancel", targetId: id };
		}
	}

	#broadcast(frame: Record<string, unknown>): void {
		for (const viewer of this.#viewers.values()) viewer.send(frame);
	}

	#requestId(scope: string): string {
		return `daemon:${scope}:${++this.#nextRequest}`;
	}
}
