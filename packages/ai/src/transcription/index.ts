import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { transcribeOpenAI, type TranscriptionOptions } from "./openai-transcriptions";
import { transcribeXai } from "./xai-stt";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

export { TranscriptionApiError } from "./errors";
export * from "./openai-transcriptions";
export * from "./types";
export * from "./xai-stt";

/** Dispatch an audio transcription through the transport selected by the catalog model. */
export function transcribeAudio(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	if (model.api === "openai-transcriptions") return transcribeOpenAI(model, request, options);
	if (model.api === "xai-stt") return transcribeXai(model, request, options);
	throw new AIError.ConfigurationError(`Unsupported transcription API: ${model.api}`);
}
