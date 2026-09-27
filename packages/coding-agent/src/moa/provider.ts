/**
 * The keyless `mixture` provider: every valid mixture definition is a model
 * `mixture/<name>` of the custom API `mixture`.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";

export const MIXTURE_PROVIDER = "mixture";
export const MIXTURE_API = "mixture";

/** Whether a model is a mixture: a structured fact of its API, never its provider name. */
export function isMixtureModel(model: Pick<Model<Api>, "api">): boolean {
	return model.api === MIXTURE_API;
}
