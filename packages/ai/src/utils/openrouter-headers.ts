import { PRODUCT_NAME, USER_AGENT } from "@oh-my-pi/pi-utils";

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"HTTP-Referer": "https://github.com/PsychedelicShayna/neopi",
		"X-OpenRouter-Title": PRODUCT_NAME,
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
