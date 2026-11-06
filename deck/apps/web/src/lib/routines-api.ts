import type {
	CreateRoutineRequest,
	GraphActivation,
	GraphNodeType,
	GraphRunRecord,
	ListRoutineRunsResponse,
	ListRoutineStepRunsResponse,
	ListRoutinesResponse,
	Routine,
	RoutineGraph,
	RoutineRun,
	RoutineWebhookStatus,
	UpdateRoutineRequest,
	ValidationError,
	ValidationResult,
} from "@npi-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string; details?: ValidationError[] };
		throw new RoutineRequestError(body.error ?? `HTTP ${res.status} ${path}`, res.status, body.details ?? []);
	}
	return (await res.json()) as T;
}

export class RoutineRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly errors: ValidationError[] = [],
	) {
		super(
			errors.length ? `${message}: ${errors.map(error => `${error.path} ${error.message}`).join("; ")}` : message,
		);
	}
}

export interface RoutineMetrics {
	total: number;
	successCount: number;
	successRate30d: number;
	p50DurationMs: number | null;
	p95DurationMs: number | null;
	mtdCostMicros: number;
	last30: Array<{ runId: string; status: "success" | "failed" | "aborted" | "running"; durationMs: number | null }>;
}

export interface TemplateSummary {
	slug: string;
	name: string;
	description?: string;
	tags?: string[];
	steps: number;
	triggers: number;
}

export const routinesApi = {
	nodeTypes(): Promise<{ nodeTypes: GraphNodeType[] }> {
		return req("/routine-node-types");
	},
	async validateGraph(graph: RoutineGraph): Promise<ValidationResult> {
		const response = await fetch(`${BASE}/routine-graphs/validate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(graph),
		});
		const result = (await response.json()) as ValidationResult;
		if ((response.ok || response.status === 400) && typeof result.valid === "boolean") return result;
		throw new RoutineRequestError(`Graph validation failed (${response.status})`, response.status);
	},
	previewGraph(id: string, activation?: GraphActivation): Promise<GraphRunRecord> {
		return req(`/routines/${encodeURIComponent(id)}/preview`, {
			method: "POST",
			body: JSON.stringify(activation ?? {}),
		});
	},
	run(id: string, runId: string): Promise<RoutineRun> {
		return req(`/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`);
	},
	graphRun(id: string, runId: string): Promise<GraphRunRecord> {
		return req(`/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/graph`);
	},
	list(): Promise<ListRoutinesResponse> {
		return req<ListRoutinesResponse>("/routines");
	},
	get(id: string): Promise<Routine> {
		return req<Routine>(`/routines/${encodeURIComponent(id)}`);
	},
	create(body: CreateRoutineRequest): Promise<Routine> {
		return req<Routine>("/routines", { method: "POST", body: JSON.stringify(body) });
	},
	update(id: string, body: UpdateRoutineRequest): Promise<Routine> {
		return req<Routine>(`/routines/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	remove(id: string): Promise<{ ok: boolean }> {
		return req(`/routines/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	runNow(
		id: string,
		params?: Record<string, unknown>,
		options?: { dryRun?: boolean },
	): Promise<{ ok: boolean; queued: boolean }> {
		const query = options?.dryRun === undefined ? "" : `?dryRun=${options.dryRun}`;
		return req(`/routines/${encodeURIComponent(id)}/run${query}`, {
			method: "POST",
			body: JSON.stringify(params ?? {}),
		});
	},
	runs(id: string, limit = 10): Promise<ListRoutineRunsResponse> {
		return req<ListRoutineRunsResponse>(`/routines/${encodeURIComponent(id)}/runs?limit=${limit}`);
	},
	steps(id: string, runId: string): Promise<ListRoutineStepRunsResponse> {
		return req<ListRoutineStepRunsResponse>(
			`/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/steps`,
		);
	},
	metrics(id: string): Promise<RoutineMetrics> {
		return req<RoutineMetrics>(`/routines/${encodeURIComponent(id)}/metrics`);
	},
	templates: {
		list(): Promise<{ templates: TemplateSummary[] }> {
			return req<{ templates: TemplateSummary[] }>("/routine-templates");
		},
		install(slug: string): Promise<Routine> {
			return req<Routine>(`/routine-templates/${encodeURIComponent(slug)}`, { method: "POST" });
		},
	},
	rotateWebhookSecret(id: string): Promise<{ ok: boolean; secret: string; path: string }> {
		return req(`/routines/${encodeURIComponent(id)}/webhook-secret/rotate`, { method: "POST" });
	},
	/** Null when the routine has no webhook registration. */
	async webhookStatus(id: string): Promise<RoutineWebhookStatus | null> {
		const res = await fetch(`${BASE}/routines/${encodeURIComponent(id)}/webhook`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`HTTP ${res.status} /routines/${id}/webhook: ${await res.text().catch(() => "")}`);
		return (await res.json()) as RoutineWebhookStatus;
	},
	/** One-way: the server never accepts the bare secret again once refused. */
	refuseWebhookBareSecret(id: string): Promise<RoutineWebhookStatus> {
		return req<RoutineWebhookStatus>(`/routines/${encodeURIComponent(id)}/webhook`, {
			method: "PATCH",
			body: JSON.stringify({ acceptBareSecret: false }),
		});
	},
};
