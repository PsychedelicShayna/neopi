import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { AuthAccountSelector } from "../../auth/types";
import type { AttributionMode, Dials, EventKind, FailoverCause, OvercommitMode, PlanEntry } from "../wire";

export type SecretRef =
	| { kind: "file"; path: string }
	| { kind: "env"; name: string }
	| { kind: "inline"; value: string }
	| { kind: "sealed"; sha256: string };
export type ChatProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export type KindProtocol =
	| "openai-embeddings"
	| "openrouter-rerank"
	| "openai-images"
	| "openai-speech"
	| "openai-transcriptions"
	| "openrouter-video";
export type GatewayRouteKind =
	| ChatProtocol
	| "pi-native"
	| "embeddings"
	| "rerank"
	| "images"
	| "images-edits"
	| "speech"
	| "transcriptions"
	| "video"
	| "video-poll"
	| "video-content"
	| "systemone"
	| "models"
	| "usage"
	| "credentials-check"
	| "healthz"
	| "me";
export type ConnectEntry =
	| { kind: "provider"; provider: string }
	| { kind: "provider-glob"; provider: string; glob: string }
	| { kind: "virtual"; id: string }
	| { kind: "mixture"; name: string }
	| { kind: "all" };

export interface ModelRow {
	id: string;
	upstreamId: string;
	kind: ModelKind;
	name?: string;
	contextWindow?: number;
	maxOutput?: number;
	reasoning?: boolean;
	efforts?: Effort[];
	effortMap?: Partial<Record<Effort, string>>;
	input?: ("text" | "image")[];
	supportsTools?: boolean;
	cost?: { input: number; output: number };
	hidden: boolean;
	aliases: string[];
	/** TOML field presence distinguishes a partial override from an added model's defaults. */
	declaredFields: readonly string[];
}
export interface ProviderConfig {
	id: string;
	kind: "catalog" | "http";
	catalog?: string;
	name: string;
	category: "direct" | "router" | "rehost" | "special";
	enabled: boolean;
	protocol?: ChatProtocol;
	baseUrl?: string;
	auth?: { scheme: "bearer" | "header" | "query" | "none"; header?: string; param?: string; key?: SecretRef };
	keys?: SecretRef[];
	pool: { strategy: "ordered" | "round-robin" | "least-used"; cooldownS: number };
	headers: Record<string, string>;
	discovery: "catalog" | "models" | "static" | "glue";
	egress: string[];
	glue?: string;
	glueReadyMs: number;
	timeouts: { firstEventMs?: number; idleMs?: number };
	options: Record<string, unknown>;
	protocols: Partial<Record<"embedding" | "rerank" | "image" | "tts" | "stt" | "video", KindProtocol>>;
	models: ModelRow[];
}
export interface EndpointConfig {
	id: string;
	explicitId: boolean;
	bind: { hostname: string; port: number };
	route: string;
	wildcard: boolean;
	protocol: "auto" | GatewayRouteKind;
	auth: "key" | "none";
	keys: string[];
	connect: ConnectEntry[];
	anonymousPlans: PlanEntry[];
	trustedProxies: string[];
	allowedOrigins: string[];
	repairs: "on" | "log-only" | "off";
	cors: boolean;
	diagnostics: "standard" | "minimal";
	maxInFlight: number;
}
export interface PlanConfig {
	id: string;
	provider: string;
	account?: AuthAccountSelector;
	name: string;
	meters?: string[];
	attribution: AttributionMode;
	size?: Record<string, { usd: number } | { tokens: number } | { requests: number }>;
	shareCapacity?: Record<string, number>;
	overcommit: OvercommitMode;
	meterGraceS: number;
	staleMaxS: number;
	staleBurnFloor: number;
	warnAt: number[];
}
export interface VirtualModelConfig {
	id: string;
	name: string;
	kind: ModelKind;
	strategy: "ordered" | "round-robin" | "least-used" | "weighted" | "sticky" | "classify";
	sticky: "conversation" | "none";
	failover: FailoverCause[];
	targets: { to: string; weight: number; when?: Record<string, string> }[];
	dials: Dials;
}
export interface AdminConfig {
	bind?: { hostname: string; port: number };
	socket: boolean;
	corsOrigins: string[];
	allowRemote: boolean;
	backupDir: string;
	tokens: { name: string; secret: SecretRef; role: "read" | "write" }[];
}
export interface NotifyConfig {
	kind: "exec" | "webhook";
	path?: string;
	url?: string;
	events: EventKind[];
	minIntervalS: number;
}
export interface SwitchConfig {
	switch: {
		name: string;
		stateDir: string;
		drainMs: number;
		metersTtlS: number;
		metersMinS: number;
		repairs: "on" | "log-only" | "off";
		timezone: string;
		maxAttempts: number;
		warnAt: number[];
		decisionDays: number;
	};
	admin?: AdminConfig;
	notify: NotifyConfig[];
	providers: ProviderConfig[];
	plans: PlanConfig[];
	endpoints: EndpointConfig[];
	models: VirtualModelConfig[];
	sources: { path: string; sha256: string }[];
	digest: string;
}
