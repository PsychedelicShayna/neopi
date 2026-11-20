Generate an audio file at output_path; this tool does not play it. Do not invoke it just to speak a conversational reply: with speech.enabled, the reply is already synthesized and played as it streams, and this file export would synthesize the same words again before the tool returns. Use this tool when the user needs a reusable audio file.

Models are selected through the speech role and its fallback chain:
- local-inference: on-device neural TTS (Phonon 31M, native runtime)
  - no network; always WAV/PCM16
  - voice set by tts.localVoice — {{localVoices}}
- xai-tts: xAI Grok Voice; MP3 or WAV
  - built-in voices: {{xaiVoices}}; custom voice IDs accepted
- openai-speech: the selected model's compatible cloud endpoint; MP3 or WAV
  - voice_id is forwarded only when explicitly set

Ordering and output:
- MP3 request: unconfigured cloud candidates are tried before unconfigured local candidates; explicitly configured speech candidates keep their order.
- Chain reaches local for a non-WAV path → output is written to the sibling .wav file.
- Cloud codec is inferred from the output_path suffix.
- Max {{maxLength}} characters.
