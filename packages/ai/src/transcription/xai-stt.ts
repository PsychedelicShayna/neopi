import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { transcriptionResponseError } from "./errors";
import type { TranscriptionOptions } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

const XAI_STT_TIMEOUT_MS = 10 * 60_000;

function emptyUsage(model: Model<Api>): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

/** Call xAI's native multipart `/stt` endpoint. */
export async function transcribeXai(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	const form = new FormData();
	form.append("model", model.id);
	const fileName = request.fileName?.trim() || "dictation.wav";
	form.append("file", new File([request.audio], fileName, { type: request.mimeType }));
	if (request.language?.trim()) form.append("language", request.language.trim());

	const timeoutSignal = AbortSignal.timeout(XAI_STT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const configuredHeaders = model.resolveHeaders ? await model.resolveHeaders(signal) : model.headers;
			const attempt = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}/stt`, {
				method: "POST",
				headers: {
					...configuredHeaders,
					Authorization: `Bearer ${key}`,
					Accept: "application/json",
					"User-Agent": USER_AGENT,
				},
				body: form,
				signal,
			});
			if (!attempt.ok) throw await transcriptionResponseError(attempt, model);
			return attempt;
		},
		{ signal },
	);

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} transcription response is malformed JSON`,
			{
				provider: model.provider,
				kind: "envelope",
				cause,
			},
		);
	}
	if (!body || typeof body !== "object") {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} transcription response is malformed: expected a text string`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	const text: unknown = "text" in body ? body.text : undefined;
	if (typeof text !== "string") {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} transcription response is malformed: expected a text string`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	return { text: text.trim(), usage: emptyUsage(model) };
}
