import type { GatewayRouteKind } from "./config/types";

export const GATEWAY_ROUTE_KINDS: readonly GatewayRouteKind[] = [
	"openai-chat", "openai-responses", "anthropic-messages", "pi-native", "embeddings", "rerank", "images", "images-edits", "speech", "transcriptions", "video", "video-poll", "video-content", "systemone", "models", "usage", "credentials-check", "healthz", "me",
];
const FIXED: Readonly<Record<string, GatewayRouteKind>> = {
	"/chat/completions": "openai-chat", "/responses": "openai-responses", "/messages": "anthropic-messages", "/messages/count_tokens": "anthropic-messages",
	"/pi/stream": "pi-native", "/embeddings": "embeddings", "/rerank": "rerank", "/images/generations": "images", "/images": "images", "/images/edits": "images-edits",
	"/audio/speech": "speech", "/audio/transcriptions": "transcriptions", "/videos": "video", "/systemone": "systemone", "/models": "models", "/usage": "usage", "/credentials/check": "credentials-check", "/switch/me": "me",
};
export interface GatewayRouteMatch { kind: GatewayRouteKind; id?: string; countTokens?: boolean }

/** Wildcards expose this exact closed suffix set, not arbitrary nested gateway routes. */
export function matchGatewayRoute(suffix: string): GatewayRouteMatch | undefined {
	if (Object.hasOwn(FIXED, suffix)) return { kind: FIXED[suffix], ...(suffix === "/messages/count_tokens" ? { countTokens: true } : {}) };
	const video = /^\/videos\/([^/]+)(\/content)?$/.exec(suffix);
	if (video) return { kind: video[2] ? "video-content" : "video-poll", id: video[1] };
	const model = /^\/models\/(.+)$/.exec(suffix);
	return model ? { kind: "models", id: model[1] } : undefined;
}

/** An exact configured path may use a well-known suffix under any fixed prefix. */
export function inferGatewayRoute(pathname: string): GatewayRouteMatch | undefined {
	for (let start = 0; start >= 0; start = pathname.indexOf("/", start + 1)) {
		const match = matchGatewayRoute(pathname.slice(start));
		if (match) return match;
	}
	return undefined;
}
