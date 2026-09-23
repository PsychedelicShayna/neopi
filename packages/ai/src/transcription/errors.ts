import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";

/** Non-2xx response from a transcription endpoint. */
export class TranscriptionApiError extends AIError.ProviderHttpError {
	override readonly name = "TranscriptionApiError";
}

export async function transcriptionResponseError(
	response: Response,
	model: Model<Api>,
): Promise<TranscriptionApiError> {
	const text = await response.text();
	let detail = text;
	let code: string | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "error" in parsed) {
			const error = parsed.error;
			if (error && typeof error === "object") {
				const envelope = error as { message?: unknown; code?: unknown; type?: unknown };
				if (typeof envelope.message === "string") detail = envelope.message;
				if (typeof envelope.code === "string") code = envelope.code;
				else if (typeof envelope.type === "string") code = envelope.type;
			}
		}
	} catch {}
	return new TranscriptionApiError(
		`${model.provider}/${model.id} transcription API error (${response.status}): ${detail || response.statusText}`,
		response.status,
		{ headers: response.headers, code },
	);
}
