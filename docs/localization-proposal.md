# NeoPi Spanish localization proposal

**Status:** proposal for discussion; no localization implementation or Spanish coverage is asserted here. This document is limited to NeoPi. NeoCode and NeoDeck are possible later consumers, not part of this proposal's implementation scope.

## Decisions already in scope

Shayna's recorded direction is to “localize the entire harness into spanish as an optional language.” She also said, “The vocabulary and command completion translation especially need to be a matter of in the loop discussion.” The recorded decision explicitly characterizes command renames (including `/roles`, `/model`, `/config`) and English fallback as **proposals for discussion, not decided** (`/mnt/alias/m2/agents/scratch/neocore/DECISIONS.md`, lines 10–11). Therefore this proposal keeps every slash-command spelling, alias, and invocation unchanged; translated labels and help text must not change the command protocol or accepted input.

## Proposed architecture

### Locale selection and settings

Add the optional user setting `language`, defaulting to `"en"`; the infra proposal currently uses `"es"` for Spanish. The product target is a neutral Latin American Spanish draft, but whether the runtime locale identifier should remain `es` or distinguish a regional tag such as `es-419` is an open question. Use English for an absent or unsupported value and do not fail startup. The setting belongs in NeoPi's existing layered settings system; the exact scope (global only or project override too) needs maintainer review.

Prefer TOML for authored locale data, matching NeoPi's settings direction and existing TOML support (`packages/coding-agent/src/config/settings-toml.ts`, `packages/coding-agent/src/config/settings.ts`). One possible catalog shape:

```toml
[meta]
locale = "es"
source_locale = "en"

[common]
"action.cancel" = "Cancel"
"action.confirm" = "Confirm"

[slash.model]
description = "..."

[slash.model.completions]
"..." = "..."
```

The shape is illustrative, not a finalized schema. Keys must be stable identifiers, not English source strings. English is the canonical source catalog; localized catalogs supply values by key. Keep command names and argument tokens out of translated values where they are executable or protocol-visible. For user-visible completion descriptions/usage prose, translate the prose but retain literal command/subcommand tokens and syntax.

### Initial infra API alignment

Localization infrastructure has implemented the API in `packages/coding-agent/src/i18n/index.ts`: exports include `Locale`, `TranslationValues`, `Catalog`, `getCatalog(locale?)`, `getLocale()`, `setLocale(locale)`, and `t(key, values?)` / `t(locale, key, values?)`. Catalogs are `packages/coding-agent/src/i18n/catalogs/{en,es}.toml`, statically imported and parsed with `Bun.TOML.parse`; they use flat dotted keys and precomputed merged English fallback. Locale is `en` by default or `es`; `cfgLanguage` applies the setting live. Missing English keys return the key string. Interpolation replaces `{name}` only for supplied string/number values; pluralization is not supported. Catalogs contain display text only: slash names and argument values remain unchanged. The visible composer fallback uses `t("composer.placeholder")`.

TOML catalogs should be checked at startup/build boundaries for structural validity, but avoid adding runtime parsing per lookup. Any proposed build-time embedding/compiled artifact must be verified against the actual Bun/bundler packaging path before treating it as an implementation constraint.


Infra's agreed lookup behavior is per-key English fallback for missing Spanish entries; when a key is absent from English too, `t(locale, key, values?)` returns the key string without throwing. Keep this deterministic and avoid translating protocol identifiers. Separately, catalog loading should validate once at startup/reload, and malformed catalog handling should fail safely to English; exact diagnostics and failure behavior remain implementation questions.

### Translation boundary and command completion

Translate interface-owned user-facing strings: prompts, menus, status/error/help text, descriptions and completion annotations. Do not translate user-authored text, model/provider identifiers, filesystem paths, tool names/protocol payloads, or slash command names/aliases/argument literals. Slash syntax is an interface contract: `/model` remains `/model` regardless of locale; the `/model` description, picker explanation, and explanatory completion prose may be localized.

Command completion must keep a strict separation between canonical values and presentation. Existing command definitions include `name`, `aliases`, `description`, subcommand `name`/`usage`/`description`, and TUI/headless completion hooks (`packages/coding-agent/src/slash-commands/types.ts`, especially lines 11–60). Completion construction uses canonical subcommand names for `value` and matching, while exposing `description` and `hint` for display (`packages/coding-agent/src/slash-commands/builtin-completions.ts`, lines 22–62). Preserve that invariant: localize only display text; completion values, prefix matching, accepted tokens, and dispatch remain the existing English identifiers. TUI and headless/RPC completion need consistent translated display text when locale is available; no translated completion may cause an invocation to execute a different command.

The existing autocomplete surface is shared by many inputs, not exclusively slash commands (`packages/tui/src/autocomplete.ts`). Localization should attach to the display boundary rather than globally rewriting arbitrary completion values.

### Runtime cost and lifecycle

- Parse catalogs once per process/catalog reload; never read or parse locale files for each rendered string or keystroke.
- Use a small immutable in-memory key/value lookup after load. Avoid allocations in hot render/autocomplete loops where the existing path can use a stable catalog reference and direct lookup.
- Resolve/fallback by key with bounded constant-time lookups; do not perform runtime machine translation, network access, or per-string locale negotiation.
- Reload only through the existing settings/reload lifecycle. If runtime locale switching is supported, it must invalidate affected rendered views coherently; startup-only selection is simpler and is acceptable for an initial design.
- Keep untranslated English available offline and ensure locale data is packaged with the application. Missing locale files must resolve to English rather than block startup.

### Completeness and correctness gates (proposed)

1. A catalog check compares each shipped locale's keys to the English source catalog and reports missing, extra, malformed, and unused keys. Missing translations may be allowed during drafting only when explicitly tracked; release completeness should require all approved user-facing keys or a documented exclusion.
2. Validate interpolation placeholders and plural/select forms against source messages; reject missing, extra, or incompatible variables. Use a single documented message-format rule if pluralization is needed; do not concatenate translated fragments around variables.
3. Test locale selection, unsupported-locale fallback, per-key English fallback, malformed-catalog fallback, and deterministic output.
4. Test representative rendering in TUI and headless/RPC command completion: descriptions/hints translate; command names, aliases, argument tokens, values, prefix filtering, dispatch and protocol-facing command advertisements remain unchanged.
5. Add review checks for untranslated user-visible literals and for catalog keys with no callsite; use allowlists for intentional English identifiers/protocol terms.
6. Maintain human review for glossary and command wording. Mechanical completeness does not establish translation quality.

These are acceptance criteria for future implementation, not evidence that tests or translated catalogs currently exist.

## Spanish language and glossary discussion

Draft translation target: **neutral Latin American Spanish**; infrastructure currently proposes the locale identifier `es`, while `es-419` remains a possible future explicit tag. Start with `tú` as the written default and avoid region-marked idioms. Uruguay requires an explicit product decision: familiar local speech commonly uses voseo (`vos`), while a neutral pan-Latin American interface may use `tú`; neither should be assumed universally preferable. `usted` conveys formality/distance and should not be mixed casually with `tú`/`vos`. Discuss whether to offer a Uruguay-specific dialect later, keep the initial Spanish consistently `tú`, or use impersonal/invariant constructions that avoid direct second-person pronouns. Do not infer dialect preference from geography or silently mix forms. Have a native Spanish reviewer approve pronouns, imperative forms, gender agreement, and tone before broad coverage.

Glossary candidates below are deliberately **unsettled**. Choose one canonical option per concept, record context and excluded meanings, then apply consistently. These examples are proposals for review, not approved terminology.

| English concept | Candidate Spanish options | Tradeoff / review question |
| --- | --- | --- |
| prompt (input to the assistant) | `mensaje`, `instrucción`, `solicitud` | `mensaje` is broad and familiar; `instrucción` can imply directive; `solicitud` is formal. Which matches NeoPi's input semantics? |
| tool | `herramienta`, retain `tool` in technical contexts | `herramienta` is understandable but may sound generic; avoid translating literal API/tool identifiers. |
| agent | `agente`, `asistente` | `agente` matches technical term and existing ecosystem; `asistente` can imply the model rather than an agent runtime. |
| subagent | `subagente`, `agente secundario`, `agente auxiliar` | `subagente` is compact and technically exact but may be unfamiliar; `secundario` can imply lower importance; `auxiliar` reads as support rather than delegated agent. Which relationship should the UI communicate? |
| role | `rol`, `perfil`, `función` | `rol` is literal and concise but may sound abstract; `perfil` is familiar but implies a bundle of traits; `función` means function/job and may be too narrow. Does NeoPi's role describe behavior, persona, or model routing? |
| compaction | `compactación`, `resumen`, `reducción del contexto` | `compactación` is technically direct but unnatural; `resumen` suggests semantic summarization only; `reducción del contexto` is clearer but longer and may misstate the operation. What does the UI action actually do? |
| steer (redirect an active agent) | `redirigir`, `orientar`, `dar indicaciones` | `redirigir` is concrete but sounds like changing destination; `orientar` is concise but vague; `dar indicaciones` is clear but longer. Which better distinguishes steering an active agent from sending a new prompt? |
| follow-up (continue after a result) | `continuación`, `seguimiento`, `mensaje posterior` | `continuación` implies continuing the same task; `seguimiento` can mean later monitoring; `mensaje posterior` is literal but not an action label. Identify whether this means continuing the agent task or asking another question. |
| session | `sesión` | Generally direct; check that it distinguishes conversation/session from login session in context. |
| provider | `proveedor`, retain provider names | Clear but potentially ambiguous outside model service context. |
| model | `modelo` | Direct; never translate model IDs. |
| reasoning effort / level | `nivel de razonamiento`, `esfuerzo de razonamiento` | “Esfuerzo” tracks internal setting, “nivel” is easier to understand; review UI space and actual control semantics. |
| context window | `ventana de contexto`, `límite de contexto` | Literal technical term versus clearer capacity concept; distinguish token capacity from current context. |
| completion (suggestion) | `sugerencia`, `autocompletado` | `sugerencia` describes an item; `autocompletado` the feature/action. Avoid confusing with task completion. |
| slash command | `comando`, `comando con /` | User-facing prose may explain the slash prefix; command tokens themselves remain unchanged. |
| cancel | `Cancelar`, `Detener` | `Cancelar` for an action not yet committed; `Detener` for running work. Keep meanings distinct. |
| settings/configuration | `configuración`, `ajustes` | `configuración` is technical; `ajustes` is familiar. Match existing product vocabulary and scope. |

## Exact command proposals — open questions, no command changes

No command spelling, alias, accepted argument, or autocomplete behavior is changed by this proposal. The following are exact proposals/questions for in-loop discussion only; the existing command definitions and behavior remain authoritative until the owner approves a decision.

1. Should `/roles` replace `/models` as the canonical spelling, and should `/model` replace `/switch`? These are the recorded candidate pairings, not authorized renames. Confirm their semantics match before considering either; retain old English spellings as working inputs if a future transition is approved.
2. For configuration, should `/config` remain canonical, with only its description and help translated? A Spanish-named alternative such as `/configuración` is only a question for review, not an alias or replacement proposal approved for use.
3. If localized Spanish slash-command names are ultimately desired, which exact names should be offered (for example `/modelo` for model selection, `/roles` for roles, and a reviewed Spanish configuration term)? Decide command-by-command; do not infer from glossary translation, and keep English command entry working.
4. If Spanish command names are approved, should English spellings remain accepted but be hidden from autocomplete in Spanish mode except when there is no Spanish match or the input is one edit away from an English command? This fallback/near-match policy is an open proposal requiring explicit approval and tests for ambiguity, prefix matching, and accidental invocation.
5. For completion display, should Spanish descriptions/hints retain English subcommand and argument literals verbatim? Recommended for correctness, but confirm command-by-command. In every option, inserted completion values, parser input and dispatch must correspond to the approved canonical command contract.

Review exact proposed strings only after inspecting their existing command definitions and usage in context. A terminology decision does not authorize a command rename.

## Future sharing boundary

If NeoCode or NeoDeck later adopts the same language, consider extracting a small shared catalog format and validator only after their owners approve and actual common keys/semantics are mapped. Keep this proposal's catalog namespace and runtime integration NeoPi-owned initially. Do not modify, import from, or make NeoPi depend on either repository as part of this work. Sharing should preserve product-specific strings and command contracts, with common keys shared only where meaning truly matches.

## Inspected NeoPi sources

- `packages/coding-agent/src/config/settings.ts` — layered settings store and setting registration.
- `packages/coding-agent/src/config/settings-toml.ts` — TOML settings support/serialization.
- `packages/coding-agent/src/slash-commands/types.ts` — canonical command metadata and separate TUI/headless completion interfaces.
- `packages/coding-agent/src/slash-commands/builtin-completions.ts` — command completion values, descriptions and hints.
- `packages/tui/src/autocomplete.ts` — general autocomplete behavior, including non-command inputs.
- `/mnt/alias/m2/agents/scratch/neocore/DECISIONS.md` — recorded user direction and explicit discussion status for vocabulary/command changes.
