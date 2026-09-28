import type { StoredChange } from "./database";
import { SwitchError } from "./error";
import type { SwitchStore } from "./store";
import type { AdminActor, AdminAuthentication } from "./admin-auth";

const encoder = new TextEncoder();
const MAX_BUFFER = 256;

function frame(change: StoredChange): Uint8Array {
	return encoder.encode(`id: ${change.frame.cursor}\nevent: ${change.kind}\ndata: ${JSON.stringify(change.frame)}\n\n`);
}

/** Subscribe/high-water capture precedes the first byte; later rows queue until replay ends. */
export function adminEventsStream(store: SwitchStore, cursor: string, actor: AdminActor, token: string | null, authentication: () => AdminAuthentication): Response {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let subscription: ReturnType<SwitchStore["subscribe"]> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let drain: ReturnType<typeof setInterval> | undefined;
	const queue: StoredChange[] = [];
	let closed = false;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		subscription?.close();
		if (heartbeat) clearInterval(heartbeat);
		if (drain) clearInterval(drain);
	};
	const resync = (reason: string) => {
		if (!controller || closed) return;
		controller.enqueue(encoder.encode(`event: resync\ndata: ${JSON.stringify({ reason })}\n\n`));
		cleanup(); controller.close();
	};
	const stillAuthorized = () => {
		try { const current = authentication().authenticate(token); return current.name === actor.name && current.role === actor.role; }
		catch { return false; }
	};
	const flush = () => {
		if (!controller || closed) return;
		if (!stillAuthorized()) { resync("operator_authority_changed"); return; }
		while (queue.length && (controller.desiredSize ?? 0) > 0) controller.enqueue(frame(queue.shift()!));
	};
	const onLive = (change: StoredChange) => {
		if (closed) return;
		if (!stillAuthorized()) { resync("operator_authority_changed"); return; }
		if (queue.length >= MAX_BUFFER) { resync("buffer_exhausted"); return; }
		queue.push(change); flush();
	};
	subscription = store.subscribe(cursor, onLive);
	const highWater = subscription.highWater;
	const initial = subscription;
	const stream = new ReadableStream<Uint8Array>({
		start(writable) {
			controller = writable;
			let position = initial.after;
			try {
				while (position < highWater) {
					const page = initial.replay(position, MAX_BUFFER);
					if (!page.length) throw new SwitchError(409, "resync_required", "Replay no longer contains the requested rows");
					for (const change of page) { writable.enqueue(frame(change)); position = change.seq; }
				}
				flush();
				drain = setInterval(flush, 100);
				heartbeat = setInterval(() => {
				if (!stillAuthorized()) { resync("operator_authority_changed"); return; }
				if ((writable.desiredSize ?? 0) <= 0) return;
				writable.enqueue(encoder.encode(": heartbeat\n\n"));
			}, 15_000);
			} catch { resync("replay_expired"); }
		},
		cancel() { cleanup(); },
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
