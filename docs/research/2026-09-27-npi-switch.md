# npi switch: folding Marineris into NeoPi, and the v3 TOML design

Status: draft for discussion, written 2026-09-27. It records Shayna's v3 intent and the result of reading
the full Marineris source (0.5 as deployed, 0.6, 0.7) alongside NeoPi's existing auth gateway and broker.
Nothing here is implemented.

Sources read:

- Marineris 0.7 (`switch` branch, 60f31d4), 0.6 (`master`, b1454bd), and the deployed 0.5 Nix package,
  copied from `root@utopia:/home/voyager/src/marineris` into `~/repos/marineris-utopia/`
- Marineris's own `DESIGN.md` (the unimplemented 0.8 "switch rewrite" spec written on 2026-09-17)
- the Go and Python upstream `~/repos/bnuuy-oaioa-proxy`
- NeoPi's `packages/ai/src/auth-gateway/*`, `packages/ai/src/auth-broker/*`, `auth-gateway-cli.ts`,
  and `docs/auth-broker-gateway.md`

## 0. What the thing is

Marineris is not a proxy and not only a router. It is a **switch**:

- **One endpoint.** One port on localhost (and optionally LAN, ZeroTier, or, reluctantly, the internet)
  serves every provider Shayna has access to, in every protocol that exists: OpenAI chat completions,
  OpenAI Responses, Anthropic Messages, and every other service those providers offer (audio in and out,
  embeddings, images, and so on).
- **Any model, any protocol.** The client asks for a model on a specific host, for example GLM on z.ai's
  own servers, Kimi on OpenCode Go, Astra, or Sonnet. The client's protocol does not have to match the
  provider's.
- **Ground rule: survive bad requests.** If the intent of a request is clear, the switch repairs basic
  errors instead of rejecting it.
- **Ground rule: providers lie, so there is always a glue layer.** `/v1/models` goes stale. Context windows
  are wrong or missing. Reasoning levels are missing: Grok 4.7 shipped without effort levels or a context
  window, and z.ai's model list was stale for about a month. No provider implements a protocol exactly.
  The switch never assumes the provider is right.
- **Ground rule: the switch is not omniscient.** It does not ship with knowledge of every provider. The
  operator declares every provider in the config. The switch knows exactly what it has been told.
- **v3 is TOML, not a dashboard.** The config must be editable over SSH in vim. TOML can express
  providers, endpoints, and routing rules. The 0.7 dashboard SPA and admin API are dropped.

Two scales matter, and they share one design:

1. **Personal.** A single `localhost` port on Shayna's own machine that combines every subscription and
   API key.
2. **Office.** Utopia serves the office LAN with minted, scoped keys and per-person usage, and every NeoPi
   install on the LAN can join the same pools without ever receiving a refresh token.

## 1. What already exists

### 1.1 Marineris, by version

| Version | Where | What it adds |
|---|---|---|
| Go `oaioa-proxy` | `~/repos/bnuuy-oaioa-proxy` (this machine, no remote) | Multi-listener sockets, static model catalogue, typed codecs, traffic log that diffs inbound and outbound bodies, TLS egress pinning |
| 0.5 | running on Utopia (`marineris.service`, `/etc/nixos/pkgs/marineris`) | Python rewrite plus multi-address listen, v1 hash-only keys with gates, backend-name model qualifiers |
| 0.6 | `master` | Account pools, plan meters, a line-oriented policy DSL, runtime accounts, HTML-string dashboard |
| 0.7 | `switch` | Lisp rule language with leases, transforms, and explain; editable v2 keys; SPA dashboard and admin API; `routes.json`; generic `openai` backends; effort clamp tables; background meters |
| 0.8 (design only) | `DESIGN.md` | One provider per file, descriptor-declared generic providers (`providers.d/*.toml`), canonical request model, single-writer state, unix admin socket, normalized meters in OMP's `UsageLimit` shape |

The central 0.7 capabilities are listed below. Evidence is in the Marineris tree under
`marineris-switch/marineris/`.

- **Dialect switching.** Chat, Responses, and Messages convert bidirectionally, streaming included, with
  Messages as the pivot format (`normalization.adapt_request`, `streams.py`). Each backend has a native
  path. Codex is forced to stream upstream, and unary JSON is assembled for the client when it asked for
  one. `ResponsesPatch` rebuilds sparse `response.completed` events.
- **Repairs.** Effort synonyms fold (`none/off→minimal`, `ultra→max`), and an unknown effort becomes max.
  Codex bodies are normalized: `system→developer`, a string `input` becomes a message list, and
  unsupported fields are stripped. Partial tool-call JSON is held until complete. Tool-result images are
  flattened to text. Fragmented OAuth and catalogue reads are handled. `count_tokens` is answered locally
  with an estimate.
- **Pools and failover.** Several accounts of one provider form a pool (least-used by plan meter,
  round-robin, or ordered). A 401 triggers one refresh. On 429, 5xx, transport errors, reauth, or a 404
  on a routed target, the next account is tried and the failed one cools down. A `fallback_model` is
  tried on a chat 403.
- **Catalogue fiction layer.** Live discovery is merged with built-in `MODEL_OVERRIDES` and
  `overrides.json`, which set context windows, effort ladders, `upstream_id`, variants, and hidden
  models. `routes.json` defines synthetic cross-provider model names with ordered targets. A slug grammar
  (`account/model[variant]:effort`) only treats a segment as a qualifier when it matches one.
- **Keys and rules.** `mrn_` keys carry scope (CIDR peers, paths, providers, model globs, efforts,
  sliding request and token limits) plus a Lisp program with `allow`, `deny`, `transform`, and `default`
  forms. Meters, leases, and body transforms are visible to that program. `explain` dry-runs a request
  through the pipeline.
- **Subscription OAuth.** Device login (xAI, Codex, Kimi), import from OMP (Anthropic), refresh under a
  per-account flock, and quarantine on terminal refresh failure.
- **Hardening.** Redirects are blocked, hop and private headers stripped, egress is pinned to the
  upstream host, and streams have idle timeouts.

### 1.2 NeoPi, today

NeoPi already ships most of the other half. Details are in `docs/auth-broker-gateway.md`.

- **auth-broker** (`npi auth-broker serve`, default `127.0.0.1:8765`) is the only writer of OAuth
  credentials. It stores them in SQLite, runs the refresher, and serves snapshots over SSE. Other hosts
  mirror it through `RemoteAuthCredentialStore`. Account pools act as filters, and usage and observed
  usage are aggregated. This is already a LAN credential mesh in which clients never see a refresh token.
- **auth-gateway** (`npi auth-gateway serve`, default `127.0.0.1:4000`) is a client of the broker. It
  serves `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, native `/v1/pi/stream`, and
  `/v1/embeddings`, `/v1/rerank`, `/v1/images*`, `/v1/audio/speech`, `/v1/audio/transcriptions`,
  `/v1/videos*`, `/v1/models`, `/v1/usage`, and `/v1/credentials/check`. Every chat request goes through
  pi-ai's `streamSimple`, so provider quirks, OAuth shaping, and mid-stream 401 refresh are handled
  exactly as in the harness. Sessions stick to a provider through `prompt_cache_key` or a derived session
  id.
- **Gaps.** Clients authenticate with a flat set of bearer tokens, with no scopes or per-person identity.
  There is no operator-declared provider config (the gateway deliberately ignores `models.yml`), no
  routes or virtual models, no mid-request try-the-next-account loop, and no policy language.

### 1.3 Capability matrix

| Capability | Marineris 0.7 | NeoPi now | Fold-in cost |
|---|---|---|---|
| Chat, Responses, and Messages on one port | yes | yes | none |
| Other modalities (audio, embeddings, images, video, rerank) | no | yes | none, NeoPi is ahead |
| Cross-dialect conversion for catalog providers | yes | yes (through pi-ai `Context`) | none |
| Cross-dialect relay for arbitrary operator-declared backends | yes | no | medium: this is the glue layer (§2.4) |
| Operator-declared providers in a config file | partial (`[[backend]]` over a fixed set of kinds) | no | high: new schema and registry |
| Multiple listen addresses | yes | one bind | small |
| Account pools with mid-request failover | yes | partial (ranking, no retry loop) | medium |
| Catalogue overrides (context window, efforts, ids) | yes | partial (KDL rules at build time, no operator overrides) | medium |
| Routes and virtual models | yes (`routes.json`) | no | medium, overlaps with MoA (#94) |
| Effort suffix in the model slug | yes | no | low |
| Scoped, minted keys | yes | no | high |
| Policy language (Lisp) | yes | no | high, or defer |
| Per-key usage | yes | per-credential only | medium |
| Plan meters driving admission and ranking | yes | partial (broker usage) | medium |
| LAN credential mesh without refresh tokens | no | yes | none |
| Credential health probe | no | yes | none |

## 2. v3 configuration model

The graph is **endpoint → glue → provider**. That is three steps, with room for a fourth (routes or
virtual models between endpoint and glue, §2.5). Each piece is declared in TOML and referenced by id,
like wiring blocks in TIS-100 or Shenzhen I/O.

### 2.1 Providers

A provider is everything the switch knows about one upstream. It is declared, never built in.

```toml
[[provider]]
id        = "zai"                          # referenced by connections
name      = "Z.ai (GLM, official)"
base_url  = "https://api.z.ai/api/coding/paas/v4"
protocol  = "openai-chat"                  # openai-chat | openai-responses | anthropic-messages | pi-native | ...
auth      = "api-key"                      # api-key | oauth | none | broker
key       = "file:~/.config/npi-switch/zai.key"   # or env:ZAI_KEY, or a literal; `broker` uses the NeoPi broker
category  = "direct"                       # direct | router | rehost | special
headers   = { "User-Agent" = "npi-switch" }
discovery = "/models"                      # or false, with models declared below
egress_pin = "api.z.ai"

[[provider.model]]                          # override or declare; wins over discovery
id              = "glm-5.3"
context_window  = 200_000
max_output      = 32_768
efforts         = ["low", "medium", "high"]
```

Notes:

- `category` is metadata for routing and display: `router` is OpenRouter or OmniRoute, `rehost` serves
  someone else's weights, `direct` is the lab itself, and `special` covers things like Cerebras.
- `auth = "broker"` means the credential lives in the NeoPi auth broker. The switch asks the broker for a
  fresh token for each request and never holds a refresh token. This is how a Utopia switch uses
  subscription accounts safely.
- `[[provider.model]]` rows replace Marineris's `MODEL_OVERRIDES` and `overrides.json`. The Grok 4.7
  missing-efforts case and the stale z.ai catalogue both become a few lines of TOML instead of a code
  change or an upstream PR.
- Several providers can share a `base_url` and differ only in credential. That is an account pool (§2.6).

### 2.2 Endpoints

An endpoint is a listening route. It carries no knowledge of providers.

```toml
[[endpoint]]
id       = "chat"                 # optional; defaults to a hash of (bind, route)
bind     = "127.0.0.1:8800"
route    = "/v1/chat/completions"
protocol = "openai-chat"          # what clients speak here
auth     = ["key:personal"]       # optional endpoint-level gate; per-key scoping is §2.7
connect  = ["glue:default"]       # ordered references

[[endpoint]]
bind     = "127.0.0.1:8800"
route    = "/v1/messages"
protocol = "anthropic-messages"
connect  = ["glue:default"]
```

- **Identity.** When `id` is omitted it is a hash of `bind` (host and port) and `route`. The host has to
  be part of it, not only the port: the same port can be bound on several interfaces (loopback, LAN,
  ZeroTier) with different gates. An explicit `id` is still allowed so that references stay readable.
- **Defaults.** The default config declares the standard three routes (chat, responses, messages) on one
  port, plus the modality routes NeoPi already serves. Extra endpoints exist to put a variant behind its
  own key, bind it to another interface, or give it a custom route such as `/v2/hello-world`.

### 2.3 Connections

`connect` lists the glue instances (or routes, §2.5) that an endpoint's traffic may take, in order. The
switch picks the first reference that can serve the requested model. A glue instance names the providers
it can reach:

```toml
[[glue]]
id        = "default"
serve     = "builtin:npi"               # the built-in path: pi-ai streamSimple
providers = ["xai", "codex", "anthropic", "opencode-go"]

[[glue]]
id        = "zai-fix"
serve     = "~/.config/npi-switch/glue/zai.py"   # any executable
providers = ["zai"]
```

### 2.4 Glue (`serve`)

Glue is the middleman between an endpoint and a provider. It adapts the client's protocol to the
provider's and fixes that provider's quirks.

- `serve = "builtin:npi"` is the default and needs no code. It runs the request through NeoPi's existing
  `streamSimple` path, which already implements every provider OMP supports natively, plus the Hermes
  portal added in the fork. Most connections use this.
- `serve = "<path>"` points at an executable. This is how a new or misbehaving provider gets support
  without a release: drop a script in a directory, reference it, and the switch picks it up.
- **Lifecycle.** The switch starts the executable lazily on first use and keeps it running. It restarts
  the process after a crash with backoff, and reloads it when the file or its config block changes, by
  draining in-flight requests first and then replacing the process.
- **Wire contract.** The switch passes a unix socket path through the environment
  (`NPI_GLUE_SOCKET`), and the glue serves plain HTTP on it. The switch forwards the already-parsed
  request, with the resolved provider block and a fresh credential in headers, and relays the streamed
  response. Plain HTTP over a socket keeps glue trivial to write in any language and keeps streaming
  natural. Stdio JSON-RPC was the alternative; it makes streaming awkward.
- **Isolation.** A misbehaving glue process can only break the connections that use it. It never takes
  the switch down.
- **Hot reload.** A change to the TOML or to a glue file activates on its own. It is validated first,
  applied atomically, and keeps the last good config on error (Marineris's `keystore.py` already does
  this for keys).

### 2.5 Routes and virtual models (the fourth step)

A route gives a made-up model name to an ordered list of targets and a strategy. Marineris 0.7 has this
as `routes.json`. The same concept carries the virtual models idea (Icarus) and mixture-of-agents
recipes (#94), so the two should share one definition format.

```toml
[[route]]
model    = "icarus"
strategy = "classify"            # ordered | least-used | round-robin | classify | moa
classifier = "jev"               # scores the request, see §5
targets  = [
  { provider = "xai",   model = "grok-4.7",  when = "code" },
  { provider = "codex", model = "gpt-6-astra", when = "reasoning" },
  { provider = "zai",   model = "glm-5.3" },
]
sticky   = "conversation"        # keep a conversation on one target; see caching in §5
```

### 2.6 Pools

Pools come from declaring several providers that differ only in credential:
`[[provider]] id = "codex-a"` and `id = "codex-b"`, both with `pool = "codex"`. A connection can then
reference the pool instead of the individual providers. Failover (429, 5xx, transport errors, reauth)
and cooldowns follow Marineris 0.7 (`transport.py` pool loop).

### 2.7 Keys (office scale)

Keys are minted locally and scoped: peers, endpoints, providers, model globs, efforts, request and token
limits, and optionally rules. Per-key usage is recorded. For the personal switch a single key, or no key
on loopback, is enough.

The Lisp rule language from 0.7 is powerful, and it was built mainly for the dashboard's visual builder.
v3 drops the dashboard, so TOML should cover the common cases (allow-lists and limits) and rules can be
ported later if they are still wanted.

## 3. Ground rule: recover from bad requests

"Intent is clear" needs a concrete boundary, or the switch will hide real mistakes.

**Repair automatically.** Each repair is recorded in an `x-npi-repairs` response header and in the
decision log.

- The client used the wrong route for its body, for example a Responses body sent to
  `/v1/chat/completions`. Detect the protocol from the body shape and translate it.
- Effort synonyms and out-of-range efforts clamp to the model's ladder (Marineris `clamp_table`).
- Provider-specific field rules: strip unsupported fields, rename `system` to `developer` for Codex,
  force streaming where the upstream requires it and assemble unary JSON for the client.
- Tool-call JSON split across events is held until complete, and malformed tool JSON gets a best-effort
  repair.
- Missing `max_tokens` where a provider requires it: fill in from the model row.
- Missing `stream` flag or a mismatched `Accept` header: follow what the client can actually receive.
- Wrong capitalization, a missing `/v1` prefix, or a trailing slash on routes.
- A model id with a known alias, a missing provider qualifier when exactly one provider serves it, or an
  effort suffix (`model:high`).

**Never repair.** Reject these with a clear error in the client's own protocol.

- A model that is ambiguous across providers with no route to decide.
- A request whose repair would change the model family, drop tools, or drop content the model would
  have needed.
- Auth failures and scope denials.

## 4. Folding into NeoPi

### 4.1 Shape

- **The broker stays** as the only credential writer and the LAN mesh.
- **The gateway becomes the `builtin:npi` glue.** Its dispatch (`handleFormatEndpoint` →
  `buildStreamOptions` → `streamSimple`) is exactly the default path.
- **A new switch layer** owns the TOML config (providers, endpoints, glue, routes, keys), the catalogue
  overrides, pools and failover, repairs, and the glue supervisor. It plugs in at:
  - the gateway boot options (`AuthGatewayBootOptions.resolveModel` and `listModels`)
  - client auth (`isAuthorized` in `auth-gateway/http.ts`)
  - pre-dispatch in the `startAuthGateway` fetch handler
  - model registration through the `ModelRegistry` runtime provider API, never the host's `models.yml`
- **Run it as its own process:** `npi switch serve --config switch.toml`, with its own systemd unit and a
  pinned version on Utopia. A bad harness release or upstream sync must not take down the office's
  inference. Interactive npi installs can update freely, and the switch upgrades when it is chosen to.

### 4.2 Python to TypeScript

| Port to TypeScript (hot path) | Keep external or drop |
|---|---|
| slug parsing, catalogue plus overrides, pool and failover loop, repairs that `streamSimple` does not already do, per-key usage, key store and hot reload | the dashboard (dropped in v3) |
| protocol detection from the body (wrong-route repair) | glue scripts (any language, by design) |
| the rule language, if kept after §2.7 | Marineris 0.7 itself, as a backend during migration |

Most of `normalization.py` and `streams.py` duplicate what pi-ai already does for catalog providers. Port
only what the `builtin:npi` path lacks, and keep one owner for each provider quirk.

### 4.3 Migration path

1. Write `npi switch serve` with TOML providers and endpoints, `builtin:npi` glue only, and one key.
   This is the personal localhost switch.
2. Add `[[provider.model]]` overrides, slug effort suffixes, and the wrong-route and repair set from §3.
3. Add external glue with the supervisor and hot reload. Declare the old Marineris on Utopia as a
   provider (`protocol = "openai-chat"`, `base_url = "http://utopia:8801/v1"`) so nothing breaks during
   the move.
4. Add pools with failover and plan meters, reusing broker usage.
5. Add minted scoped keys and per-key usage (office scale), then routes and virtual models shared with
   MoA.
6. Retire Marineris on Utopia.

## 5. Routing, caching, and classifiers (idea backlog)

- **Caching dominates routing cost.** Prompt caches are keyed per model on most providers, so switching
  models mid-conversation pays a cold start each time. Routes default to `sticky = "conversation"` and
  switch only at deliberate boundaries (plan → implement, a summarization hand-off).
- **xAI cross-model continuation.** Shayna reports that `previous_response_id` continues across model
  slugs on the xAI subscription, reusing the earlier reasoning. If that holds, switches between xAI
  models are cheap and the router can weight them accordingly. This is unverified and should be measured
  before the design relies on it. Anthropic caching is per model; treat any switch there as cold.
- **Jev as the first stage.** A classifier scores the request along declared axes (task type,
  difficulty, length, tools), and the route picks a target with cache affinity as one term of the score.
  The classifier should never be the only input.
- **Shared recipes.** Virtual models, routes, and MoA recipes defined once and usable from npi, the
  switch, and other people's installs on the LAN.

## 6. Risks

- **Provider terms.** Pooling consumer subscription OAuth accounts (Claude, ChatGPT, SuperGrok) across
  several people usually breaks the provider's terms and risks bans. Per-person keys make usage
  traceable; they do not make pooling allowed. Decide account by account what goes in a shared pool.
- **Double translation.** A request that passes through both a glue script's conversion and
  `streamSimple`'s is lossy. Each connection gets exactly one translation owner.
- **Reload semantics.** Admission decisions are fixed when a request is admitted. Config reloads apply
  to new requests only. Glue replacement drains first.
- **Secrets.** The config holds `file:`/`env:` references, never literal keys, in anything that might
  be committed or put in the Nix store (as Marineris already does).
- **Three auth layers** (switch keys, gateway bearer, broker bearer). Each needs a documented trust
  boundary. Broker account pools are routing filters, not authorization.

## 7. Open questions for Shayna

1. **Glue contract.** Is HTTP over a unix socket acceptable, or do you want stdio, or the option of
   either?
2. **Rules.** Keep the 0.7 Lisp rule language in v3, or cover keys with TOML scope fields only?
3. **Endpoint ids.** Hash of `(bind, route)` as the default with an optional explicit id, or explicit ids
   only?
4. **Repair visibility.** Is an `x-npi-repairs` header plus the decision log enough, or should repairs be
   off by default per endpoint?
5. **Name.** Does this stay "Marineris" as the switch's name inside NeoPi, or become `npi switch`?

---

Related: #94 (mixture of agents), `docs/research/2026-09-26-multi-agent-orchestration.md`,
`docs/auth-broker-gateway.md`.

— Opus (anthropic/claude-opus-5-5) via npi
