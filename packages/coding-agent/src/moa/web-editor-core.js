"use strict";
/* Mixture Studio · core: state, document helpers, live checks, edits and undo.
   The draft documents are NeoPi's own MixturesConfigDoc shape (camelCase, as the server sends them).
   Keys starting with "$" are view state (card positions, stable edge keys) and are never sent back. */
/* ═══════════════════════════ HELPERS ═══════════════════════════ */
const $ = id => document.getElementById(id);
const PROPS = new Set([
	"value",
	"checked",
	"disabled",
	"hidden",
	"selected",
	"tabIndex",
	"textContent",
	"placeholder",
	"title",
	"rows",
	"draggable",
]);
function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const k in attrs || {}) {
		const v = attrs[k];
		if (v == null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "style") {
			for (const s in v) s.startsWith("--") ? el.style.setProperty(s, v[s]) : (el.style[s] = v[s]);
		} else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (PROPS.has(k)) el[k] = v;
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const kid of kids.flat(Infinity)) {
		if (kid == null || kid === false || kid === "") continue;
		el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
	}
	return el;
}
const cls = (...names) => names.filter(Boolean).join(" ");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = value => JSON.parse(JSON.stringify(value));
const present = v => v !== undefined && v !== null && v !== "";
const own = (obj, key) => obj != null && Object.hasOwn(obj, key);
const IC = {
	plus: '<path d="M8 3v10M3 8h10"/>',
	minus: '<path d="M3 8h10"/>',
	x: '<path d="M4 4l8 8M12 4l-8 8"/>',
	check: '<path d="M3.5 8.5l3 3 6-7"/>',
	chev: '<path d="M4 6l4 4 4-4"/>',
	right: '<path d="M3 8h10M9 4l4 4-4 4"/>',
	left: '<path d="M13 8H3M7 4L3 8l4 4"/>',
	up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
	down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
	loop: '<path d="M13 8a5 5 0 1 1-1.6-3.6M13 2.8v2.7h-2.7"/>',
	spark: '<path class="f" d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6z"/><path class="f" d="M12.6 10.8l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',
	scale: '<path d="M8 3v10M5 13h6M3.5 5h9M3.5 5l-1.6 4a1.9 1.9 0 0 0 3.2 0zM12.5 5l-1.6 4a1.9 1.9 0 0 0 3.2 0z"/>',
	diamond: '<path class="f" d="M8 2l6 6-6 6-6-6z"/>',
	diamondo: '<path d="M8 2.6L13.4 8 8 13.4 2.6 8z"/>',
	dot: '<circle class="f" cx="8" cy="8" r="3.4"/>',
	lock: '<path d="M5.2 7V5.3a2.8 2.8 0 0 1 5.6 0V7M4 7h8v6H4z"/>',
	flag: '<path d="M4 13.5v-11M4 3h7.5l-1.6 2.5L11.5 8H4"/>',
	search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L13.5 13.5"/>',
	play: '<path class="f" d="M5 3.2v9.6l8-4.8z"/>',
	undo: '<path d="M6 4L3 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H8"/>',
	redo: '<path d="M10 4l3 3-3 3M13 7H6.5a3.5 3.5 0 0 0 0 7H8"/>',
	tidy: '<rect x="2.5" y="3" width="4.5" height="3.6" rx="1"/><rect x="9" y="9.4" width="4.5" height="3.6" rx="1"/><path d="M7 4.8h2.3a2 2 0 0 1 2 2v2.6"/>',
	link: '<circle cx="3.5" cy="8" r="1.6"/><circle cx="12.5" cy="8" r="1.6"/><path d="M5.1 8h5.8M9 6l2 2-2 2"/>',
	copy: '<path d="M6 6h7v7H6zM3 10V3h7"/>',
	download: '<path d="M8 3v7M5 7.5l3 3 3-3M3 13h10"/>',
	trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
	swap: '<path d="M3 5.5h10M10.5 3l2.5 2.5-2.5 2.5M13 10.5H3M5.5 8L3 10.5 5.5 13"/>',
	warn: '<path d="M8 3l5.5 10h-11zM8 7v3M8 11.7v.1"/>',
	pause: '<path d="M5.5 4v8M10.5 4v8"/>',
	layers: '<path d="M8 3l5.5 3L8 9 2.5 6zM2.5 9.6L8 12.6l5.5-3"/>',
	mail: '<path d="M2.5 4.5h11v7h-11zM2.5 5l5.5 4 5.5-4"/>',
	eyeoff:
		'<path d="M6.2 4A7 7 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a11 11 0 0 1-1.9 2.4M10.6 11.9A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.7-3.1M2.5 2.5l11 11"/>',
	hour: '<path d="M4.5 2.5h7M4.5 13.5h7M5 2.5c0 3 6 3.5 6 5.5s-6 2.5-6 5.5M11 2.5c0 3-6 3.5-6 5.5s6 2.5 6 5.5"/>',
	fit: '<path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"/>',
	file: '<path d="M4.5 2.5h5l3 3v8h-8zM9.5 2.5v3h3"/>',
	dots: '<circle class="f" cx="3.5" cy="8" r="1.2"/><circle class="f" cx="8" cy="8" r="1.2"/><circle class="f" cx="12.5" cy="8" r="1.2"/>',
	side: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M10 3v10"/>',
	list: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M6 3v10"/>',
	pin: '<path d="M6 2.5h4l-.6 4 2.1 2.2H4.5l2.1-2.2zM8 8.7v4.8"/>',
	edit: '<path d="M3 13l.6-2.8L10.8 3l2.2 2.2-7.2 7.2zM9.6 4.2l2.2 2.2"/>',
	info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.2v3.6M8 5.2v.1"/>',
	dup: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4.5A1.5 1.5 0 0 1 4.5 3h6"/>',
};
function icon(name, size = 14) {
	const t = document.createElement("template");
	t.innerHTML = `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${IC[name] || ""}</svg>`;
	return t.content.firstChild;
}
const svgEl = (tag, attrs) => {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const k in attrs || {}) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
	return el;
};
Object.defineProperty(Element.prototype, "also", {
	value(fn) {
		fn(this);
		return this;
	},
	configurable: true,
});

/* ═══════════════════════════ CONSTANTS ═══════════════════════════ */
const W = 256; // card width, in graph units
const PARTS = ["output", "input", "reasoning", "toolTrace", "transcript"];
/* A part as it is written in MIXTURES.toml and in templates. Never translated. */
const partToken = part => (part === "toolTrace" ? "tool_trace" : part);
const partHint = part =>
	({
		output: T("part.output"),
		input: T("part.input"),
		reasoning: T("part.reasoning"),
		toolTrace: T("part.toolTrace"),
		transcript: T("part.transcript"),
	})[part];
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/,
	NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/* Edge ids the engine keeps in plain lookup tables or reserves for itself. */
const reservedEdge = id =>
	id === "limit"
		? T("chk.edge.reserved.limit")
		: id === "pause"
			? T("chk.edge.reserved.pause")
			: [
						"constructor",
						"toString",
						"valueOf",
						"hasOwnProperty",
						"__proto__",
						"isPrototypeOf",
						"toLocaleString",
						"propertyIsEnumerable",
				  ].includes(id)
				? T("chk.edge.reserved.builtin")
				: null;
/* Server validation codes this file checks itself (with friendlier words and one-click repairs).
   Anything else the server reports is shown as the server words it. */
const COVERED = new Set([
	"name.invalid",
	"name.duplicate",
	"members.empty",
	"member.id",
	"entry.unresolved",
	"entry.verdict",
	"edge.endpoint",
	"edge.from_verdict",
	"edge.x.empty",
	"edge.x.unknown_part",
	"edge.envelope.undeclared_part",
	"edge.envelope.unresolved",
	"edge.id.duplicate",
	"route.required",
	"route.options",
	"route.fallback",
	"route.when.missing",
	"verdict.question",
	"limits.target",
	"limits.exceeds",
	"unsupported.feature",
	"cycle.unbounded",
	"unreachable",
	"member.role.unresolved",
	"member.prompt.missing",
	"terminate.terminal",
	"member.show.final",
]);

/* ═══════════════════════════ STATE ═══════════════════════════ */
let boot = null; // what the server knows that is not a document: models, defaults, bundled presets
let sources = []; // every MIXTURES.toml NeoPi reads for this workspace, in its order (later wins)
const files = new Map(); // sourceId → {base: snapshot from disk, doc: the draft, theirs?: a newer snapshot}
let cur = null; // {sid, index}: the mixture on the canvas
let doc = null,
	mix = null; // the draft document and mixture cur points at
let sel = null; // {kind:'node', id} | {kind:'edge', id: edge.$k} | null (the mixture itself)
const multi = new Set();
let tab = "inspect",
	panelOpen = true,
	focusSection = null;
let issues = [];
let server = { seq: 0, issues: [], reports: [], toml: null, map: [], pending: false }; // the harness's own validation of the current file
const cam = { x: 0, y: 0, z: 1 };
const geo = new Map(); // member id → {x,y,w,h,rows:{key:offsetY},ends}
let gesture = null,
	connect = null,
	trial = null,
	hoverEdge = null;
const undoStack = [],
	redoStack = [];
let typingKey = null,
	edgeSeq = 0;
const D = () => boot.defaults;
const srcOf = sid => sources.find(s => s.id === sid);
const fileOf = sid => files.get(sid);
const writable = s => !!s && !s.readOnly && !fileOf(s.id)?.base.broken;
const readOnly = () => !writable(srcOf(cur?.sid));
const scopeWord = s => (s.kind === "user" ? T("scope.user") : T("scope.project"));

/* ═══════════════════════════ DOCUMENTS ═══════════════════════════ */
function adopt(snapshotDoc, sid) {
	const d = clone(snapshotDoc ?? { mixtures: [] });
	delete d.warnings;
	d.mixtures ??= [];
	for (const m of d.mixtures) {
		m.$o = { sid, name: m.name };
		m.members ??= [];
		m.edges ??= [];
		for (const e of m.edges) e.$k = "k" + ++edgeSeq;
	}
	return d;
}
/* Key-order-independent structure without view keys; `undefined` members are absent. */
function structure(value) {
	if (Array.isArray(value)) return "[" + value.map(structure).join(",") + "]";
	if (value && typeof value === "object")
		return (
			"{" +
			Object.keys(value)
				.filter(k => k[0] !== "$" && value[k] !== undefined)
				.sort()
				.map(k => JSON.stringify(k) + ":" + structure(value[k]))
				.join(",") +
			"}"
		);
	return JSON.stringify(value) ?? "null";
}
const bare = value => JSON.parse(JSON.stringify(value, (k, v) => (k[0] === "$" ? undefined : v)));
/* A mixture that was never on disk and has no members yet is a scratch pad: it is not written, and not an error. */
const isScratch = m => !m.$o && !m.members.length;
/* The document as it would be saved, plus map[i] = index in the draft of the i-th mixture sent. */
function sendable(sid) {
	const d = fileOf(sid).doc,
		map = [];
	const out = bare({ ...d, mixtures: d.mixtures.filter((m, i) => !isScratch(m) && map.push(i)) });
	return { doc: out, map };
}
const fileDirty = sid => {
	const f = fileOf(sid);
	return !!f && structure(sendable(sid).doc) !== structure({ ...f.base.doc, warnings: undefined });
};
const dirtyFiles = () => sources.filter(s => fileDirty(s.id));
const dirty = () => dirtyFiles().length > 0;
/* How one mixture differs from what is on disk: new · moved · renamed · edited · null */
function mixState(m, sid) {
	if (!m.$o) return "new";
	if (m.$o.sid !== sid) return "moved";
	const was = fileOf(sid)?.base.doc?.mixtures?.find(x => x.name === m.$o.name);
	if (!was) return "new";
	if (m.name !== m.$o.name) return "renamed";
	return structure(m) === structure(was) ? null : "edited";
}
function sync() {
	const f = cur && fileOf(cur.sid);
	doc = f?.doc ?? null;
	mix = doc?.mixtures[cur.index] ?? null;
	if (!mix) {
		cur = null;
		doc = null;
	}
}

/* ── graph queries ── */
const isModel = n => !!n && n.kind !== "verdict";
const node = id => mix.members.find(n => n.id === id);
const isFan = e => Array.isArray(e.to);
const targets = e => (isFan(e) ? e.to : [e.to]);
const eid = e => e.id || (isFan(e) ? `${e.from}->[${e.to.join(",")}]` : `${e.from}->${e.to}`);
const edge = k => mix.edges.find(e => e.$k === k);
const outs = id => mix.edges.filter(e => e.from === id);
const liveOuts = id => mix.edges.filter(e => e.from === id && !isFan(e));
const ins = id => mix.edges.filter(e => targets(e).includes(id));
const selIs = (kind, id) => sel?.kind === kind && sel.id === id;
const onLimit = () => mix.limits?.onLimit ?? D().onLimit;
const limitTarget = () => {
	const n = onLimit() === "judge" && node(mix.limits?.limitTarget);
	return isModel(n) ? n : null;
};
const isBranch = e => !isFan(e) && liveOuts(e.from).length >= 2;
const cap = e => e.maxTraversals;
const hasPart = (e, p) => !!e.x?.[p];
const partsOf = e => PARTS.filter(p => hasPart(e, p));
const partsText = e => partsOf(e).map(partToken).join(" + ") || T("path.nothing");
const freeId = (base, taken) => {
	let i = 2;
	while (taken.has(base + i)) i++;
	return base + i;
};
function nextNodeId(kind) {
	const taken = new Set(mix.members.map(n => n.id));
	const base = kind === "verdict" ? "verdict" : "model";
	return taken.has(base) ? freeId(base + "-", taken) : base;
}
/* Effective tools, as the engine resolves them: explicit, else on for a model nothing leads on from. */
const fanTargets = () => new Set(mix.edges.flatMap(e => (isFan(e) ? e.to : [])));
const toolsOn = n =>
	isModel(n) && (n.tools !== undefined ? n.tools !== false : !fanTargets().has(n.id) && !outs(n.id).length);
/* An envelope value is an inline template when it has a newline or a {{…}}; otherwise it names a preset. */
const isInline = value => typeof value === "string" && (value.includes("\n") || value.includes("{{"));
const envName = e => (e.envelope === undefined ? "handoff" : isInline(e.envelope) || e.$inline ? null : e.envelope);
function presetText(kind, name) {
	if (!name) return undefined;
	if (own(mix[kind], name)) return { text: mix[kind][name], scope: "mixture" };
	if (own(doc[kind], name)) return { text: doc[kind][name], scope: "file" };
	if (own(boot.bundled[kind], name)) return { text: boot.bundled[kind][name], scope: "bundled" };
	return undefined;
}
const envText = e => (envName(e) === null ? e.envelope : presetText("envelopes", envName(e))?.text);
function presetNames(kind) {
	const seen = new Map();
	for (const name of Object.keys(boot.bundled[kind])) seen.set(name, "bundled");
	for (const name of Object.keys(doc[kind] ?? {})) seen.set(name, "file");
	for (const name of Object.keys(mix[kind] ?? {})) seen.set(name, "mixture");
	return [...seen].map(([name, scope]) => ({ name, scope }));
}
/* Envelope names with a fixed job: they are not offered as a path's envelope. */
const RESERVED_ENVELOPES = ["entry", "limit", "verdict"];

/* What a card says happens after it answers, in engine order: stop check → choose a path → end.
   Every consumer (card, wires, story, trial run) reads this one list, so they cannot disagree. */
function rowsOf(n) {
	if (!isModel(n)) return [{ t: "final", key: ":final", text: T("row.verdictFinal") }];
	const rows = [],
		all = outs(n.id),
		live = all.filter(e => !isFan(e)),
		locked = all.filter(isFan);
	if (n.terminate) rows.push({ t: "stop", key: ":stop", text: n.terminate.instructions });
	if (!all.length) rows.push({ t: "final", key: ":final", text: n.terminate ? T("row.finalElse") : T("row.final") });
	if (live.length >= 2) rows.push({ t: "head", key: ":head" });
	live.forEach((e, i) =>
		rows.push({ t: live.length >= 2 ? "branch" : "always", key: e.$k, edge: e, last: i === live.length - 1 }),
	);
	for (const e of locked) rows.push({ t: "locked", key: e.$k, edge: e });
	if (live.length && live.every(e => cap(e) > 0))
		rows.push({
			t: "ends",
			key: ":ends",
			text: live.length === 1 ? T("row.endsAfter", { n: cap(live[0]) }) : T("row.endsAll"),
		});
	return rows;
}
/* A card with nothing to decide draws no rows: its one wire leaves from the name itself. */
function isSimple(n, rows = rowsOf(n)) {
	if (rows.length !== 1) return false;
	const r = rows[0];
	return r.t === "final" || (r.t === "always" && cap(r.edge) === undefined && !r.edge.when);
}
function reachable() {
	const seen = new Set();
	const walk = id => {
		if (seen.has(id) || !node(id)) return;
		seen.add(id);
		for (const e of outs(id)) for (const to of targets(e)) walk(to);
	};
	if (mix.entry) walk(mix.entry);
	return seen;
}
/* What a selector lands on. The server's answer wins; the catalogue is the instant guess while it is on its way. */
function resolveModel(n) {
	const told = harnessMember(n.id);
	if (told) return { state: "ok", res: told.model, effort: told.effort };
	const selector = (n.model ?? "").trim();
	if (!selector) return { state: "missing" };
	const [base, suffix] = splitEffort(selector),
		hit = boot.models.find(m => m.selector === base);
	if (!hit) return { state: "unknown" };
	return { state: "ok", res: hit.resolved ?? hit.selector, effort: suffix || hit.effort, role: !!hit.role };
}
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
function splitEffort(selector) {
	const at = selector.lastIndexOf(":"),
		suffix = at > 0 ? selector.slice(at + 1) : "";
	return EFFORTS.includes(suffix) ? [selector.slice(0, at), suffix] : [selector, ""];
}

/* ═══════════════════════════ CHECKS ═══════════════════════════
   Live, on every change. Each finding names its object and, where one exists, a one-click repair.
   sev: e blocks saving this mixture · w is worth a look · i explains an effect. `locked` names the milestone. */
function sccs() {
	const index = new Map(),
		low = new Map(),
		stack = [],
		on = new Set(),
		out = [];
	let next = 0;
	const visit = id => {
		index.set(id, next);
		low.set(id, next++);
		stack.push(id);
		on.add(id);
		for (const e of outs(id))
			for (const to of targets(e)) {
				if (!node(to)) continue;
				if (!index.has(to)) {
					visit(to);
					low.set(id, Math.min(low.get(id), low.get(to)));
				} else if (on.has(to)) low.set(id, Math.min(low.get(id), index.get(to)));
			}
		if (low.get(id) !== index.get(id)) return;
		const comp = [];
		let top;
		do {
			top = stack.pop();
			on.delete(top);
			comp.push(top);
		} while (top !== id);
		if (comp.length > 1 || outs(id).some(e => targets(e).includes(id))) out.push(comp);
	};
	for (const n of mix.members) if (!index.has(n.id)) visit(n.id);
	return out;
}
/* Loops with nothing that can end them: no stop check inside, no capped path inside, no routed way out. */
function endlessLoops() {
	return sccs()
		.map(comp => {
			const inside = new Set(comp),
				internal = mix.edges.filter(e => inside.has(e.from) && targets(e).some(t => inside.has(t)));
			const bounded =
				comp.some(id => node(id).terminate) ||
				internal.some(e => cap(e) !== undefined) ||
				comp.some(
					id => isModel(node(id)) && node(id).route && outs(id).some(e => targets(e).some(t => !inside.has(t))),
				);
			return bounded ? null : { ids: comp.reverse(), edge: internal.find(e => !isFan(e)) };
		})
		.filter(Boolean);
}
const referencedParts = template =>
	[
		...new Set(
			[...template.matchAll(/\{\{[^}]*?\bx\.(\w+)/g)].map(m => (m[1] === "tool_trace" ? "toolTrace" : m[1])),
		),
	].filter(p => PARTS.includes(p));
const starterRoute = id => T("route.starter", { id });
const posInt = v => Number.isSafeInteger(v) && v > 0;
function check() {
	const found = [];
	const add = (sev, kind, id, msg, more) => found.push({ sev, kind, id, msg, ...more });
	const models = mix.members.filter(isModel),
		L = mix.limits ?? {};
	if (!NAME_RE.test(mix.name || "")) add("e", "mix", null, T("chk.name.invalid"), { field: "name" });
	if (doc.mixtures.filter(m => m.name === mix.name).length > 1)
		add("e", "mix", null, T("chk.name.duplicate", { name: mix.name }), { field: "name" });
	const firstModel = models[0] && {
		fix: {
			label: T("chk.entry.fix", { id: models[0].id }),
			run: () => {
				mix.entry = models[0].id;
			},
		},
	};
	if (!mix.members.length) add(mix.$o ? "e" : "i", "mix", null, T("chk.members.empty"));
	else if (!node(mix.entry)) add("e", "mix", null, T("chk.entry.none"), firstModel);
	else if (!isModel(node(mix.entry))) add("e", "node", mix.entry, T("chk.entry.verdict"), firstModel);
	if (mix.members.length > boot.limits.members)
		add("e", "mix", null, T("chk.members.max", { n: mix.members.length, max: boot.limits.members }));
	if (mix.edges.length > boot.limits.edges)
		add("e", "mix", null, T("chk.edges.max", { n: mix.edges.length, max: boot.limits.edges }));
	if (mix.serve === true)
		add("e", "mix", null, T("chk.serve"), {
			locked: "M6",
			fix: {
				label: T("chk.serve.fix"),
				run: () => {
					delete mix.serve;
				},
			},
		});
	if (mix.steering)
		add("e", "mix", null, T("chk.steering", { id: mix.steering.target }), {
			locked: "M3",
			fix: {
				label: T("chk.steering.fix"),
				run: () => {
					delete mix.steering;
				},
			},
		});
	const count = new Map();
	for (const n of mix.members) count.set(n.id, (count.get(n.id) ?? 0) + 1);
	for (const n of mix.members) {
		if (!ID_RE.test(n.id)) add("e", "node", n.id, T("chk.id.invalid"), { field: "id" });
		if (count.get(n.id) > 1) add("e", "node", n.id, T("chk.id.duplicate", { id: n.id }), { field: "id" });
		const live = liveOuts(n.id),
			all = outs(n.id);
		if (!isModel(n)) {
			const q = n.question ?? {};
			if (!q.instructions?.trim()) add("e", "node", n.id, T("chk.verdict.question"), { field: "question" });
			if (q.type === "choice") {
				const labels = choicesOf(n).map(c => c[0].trim());
				if (labels.length < 2) add("e", "node", n.id, T("chk.verdict.choices"), { field: "criteria" });
				if (labels.some(l => !l)) add("e", "node", n.id, T("chk.verdict.label"), { field: "criteria" });
				if (new Set(labels.map(l => l.toLowerCase())).size < labels.length)
					add("e", "node", n.id, T("chk.verdict.sameLabel"), { field: "criteria" });
				if (labels.some(l => /^\d+$/.test(l)))
					add("w", "node", n.id, T("chk.verdict.numeric"), { field: "criteria" });
			}
			if (q.type === "score") {
				const levels = q.criteria ?? [];
				if (levels.length < 2) add("e", "node", n.id, T("chk.verdict.levels"), { field: "criteria" });
				else if (levels.some(l => !l.trim())) add("w", "node", n.id, T("chk.verdict.level"), { field: "criteria" });
			}
			if (n.render !== undefined && !presetText("envelopes", n.render))
				add("e", "node", n.id, T("chk.verdict.render", { name: n.render }), {
					field: "render",
					fix: {
						label: T("chk.verdict.render.fix"),
						run: () => {
							delete n.render;
						},
					},
				});
			if (n.show === "never") add("i", "node", n.id, T("chk.show.final"), { field: "show" });
			continue;
		}
		if (!n.model?.trim()) add("e", "node", n.id, T("chk.model.missing"), { field: "model" });
		if (n.systemPrompt === undefined && n.role === undefined)
			add("e", "node", n.id, T("chk.prompt.missing"), {
				field: "prompt",
				fix: {
					label: T("chk.prompt.missing.fix"),
					run: () => {
						n.systemPrompt = "";
					},
				},
			});
		else if (n.systemPrompt === undefined && !presetText("roles", n.role))
			add("e", "node", n.id, T("chk.role.unresolved", { name: n.role }), { field: "prompt" });
		else if (n.systemPrompt !== undefined && n.role !== undefined)
			add("i", "node", n.id, T("chk.role.dormant", { name: n.role }), {
				field: "prompt",
				fix: {
					label: T("chk.role.dormant.fix"),
					run: () => {
						delete n.role;
					},
				},
			});
		else if (n.systemPrompt === "") add("i", "node", n.id, T("chk.prompt.empty"), { field: "prompt" });
		if (n.maxTokens !== undefined && !posInt(n.maxTokens))
			add("e", "node", n.id, T("chk.maxTokens"), { field: "maxTokens" });
		if (toolsOn(n))
			add(
				"e",
				"node",
				n.id,
				n.tools === undefined
					? T("chk.tools.implicit")
					: T("chk.tools.on", { value: Array.isArray(n.tools) ? "[" + n.tools.join(", ") + "]" : "true" }),
				{
					locked: "M3",
					field: "tools",
					fix: {
						label: T("chk.tools.fix"),
						run: () => {
							n.tools = false;
						},
					},
				},
			);
		const routeFix = {
			label: T("chk.route.remove"),
			run: () => {
				delete n.route;
			},
		};
		if (live.length >= 2 && !n.route?.instructions?.trim())
			add("e", "node", n.id, T("chk.route.required", { n: live.length }), {
				field: "route",
				fix: {
					label: T("chk.route.required.fix"),
					run: () => {
						n.route = { ...n.route, instructions: starterRoute(n.id) };
					},
				},
			});
		else if (n.route && !n.route.instructions?.trim())
			add("e", "node", n.id, T("chk.route.blank"), { field: "route", fix: routeFix });
		else if (live.length === 1 && n.route)
			add("i", "node", n.id, T("chk.route.bypassed"), { field: "route", fix: routeFix });
		else if (!all.length && n.route)
			add("e", "node", n.id, T("chk.route.options"), { field: "route", fix: routeFix });
		const fb = n.route?.fallback;
		if (fb && fb !== "pause" && !all.some(e => eid(e) === fb))
			add("e", "node", n.id, T("chk.route.fallback", { id: fb }), {
				field: "route",
				fix: {
					label: T("chk.route.fallback.fix"),
					run: () => {
						delete n.route.fallback;
					},
				},
			});
		if (n.route?.minConfidence !== undefined && !(n.route.minConfidence >= 0 && n.route.minConfidence <= 1))
			add("e", "node", n.id, T("chk.confidence"), { field: "route" });
		if (n.terminate?.threshold !== undefined && !(n.terminate.threshold >= 0 && n.terminate.threshold <= 1))
			add("e", "node", n.id, T("chk.threshold"), { field: "stop" });
		if (n.terminate && !n.terminate.instructions?.trim())
			add("e", "node", n.id, T("chk.stop.blank"), { field: "stop" });
		else if (n.terminate && !all.length) add("i", "node", n.id, T("chk.stop.terminal"), { field: "stop" });
		if (n.show === "never" && !all.length) add("i", "node", n.id, T("chk.show.terminal"), { field: "show" });
	}
	const ids = new Map();
	for (const e of mix.edges) ids.set(eid(e), (ids.get(eid(e)) ?? 0) + 1);
	for (const e of mix.edges) {
		const from = node(e.from),
			id = eid(e),
			k = e.$k,
			why = reservedEdge(id);
		if (ids.get(id) > 1)
			add("e", "edge", k, e.id ? T("chk.edge.duplicate", { id }) : T("chk.edge.parallel"), {
				field: "id",
				fix: {
					label: T("chk.edge.duplicate.fix"),
					run: () => {
						e.id = uniqueEdgeId(e);
					},
				},
			});
		if (why)
			add("e", "edge", k, T("chk.edge.reserved", { id, why }), {
				field: "id",
				fix: { label: T("chk.edge.reserved.fix"), run: () => renameEdge(e, uniqueEdgeId(e)) },
			});
		if (!from) add("e", "edge", k, T("chk.edge.from", { id: e.from }));
		else if (!isModel(from)) add("e", "edge", k, T("chk.edge.fromVerdict"));
		for (const to of targets(e)) if (!node(to)) add("e", "edge", k, T("chk.edge.to", { id: to }));
		if (!partsOf(e).length)
			add("e", "edge", k, T("chk.edge.empty"), {
				field: "parts",
				fix: {
					label: T("chk.edge.empty.fix"),
					run: () => {
						(e.x ??= {}).output = true;
					},
				},
			});
		for (const key of Object.keys(e.x ?? {}))
			if (!PARTS.includes(key))
				add("e", "edge", k, T("chk.edge.unknownPart", { key }), {
					field: "parts",
					fix: {
						label: T("chk.edge.unknownPart.fix"),
						run: () => {
							delete e.x[key];
						},
					},
				});
		if (cap(e) !== undefined && !(Number.isSafeInteger(cap(e)) && cap(e) >= 0))
			add("e", "edge", k, T("chk.edge.cap"), { field: "cap" });
		else if (cap(e) === 0)
			add("w", "edge", k, T("chk.edge.capZero"), {
				field: "cap",
				fix: {
					label: T("chk.edge.capZero.fix"),
					run: () => {
						delete e.maxTraversals;
					},
				},
			});
		if (isFan(e)) {
			add("e", "edge", k, T("chk.fanout", { ids: e.to.join(" + ") }), {
				locked: "M4",
				fix: { label: T("chk.fanout.fix"), run: () => convertFanout(e) },
			});
			continue;
		}
		const to = node(e.to),
			tr = typeof e.x?.transcript === "object" ? e.x.transcript : null;
		if (isBranch(e) && !e.when?.trim()) add("w", "edge", k, T("chk.edge.when"), { field: "when" });
		if (isModel(to)) {
			const name = envName(e),
				text = envText(e);
			if (name === null && !isInline(e.envelope))
				add("e", "edge", k, T("chk.envelope.oneLine"), {
					field: "envelope",
					fix: {
						label: T("chk.envelope.oneLine.fix"),
						run: () => {
							const made = freeId("envelope-", new Set(presetNames("envelopes").map(p => p.name)));
							(mix.envelopes ??= {})[made] = e.envelope;
							e.envelope = made;
							delete e.$inline;
						},
					},
				});
			else if (text === undefined)
				add("e", "edge", k, T("chk.envelope.unresolved", { name }), {
					field: "envelope",
					fix: {
						label: T("chk.envelope.unresolved.fix"),
						run: () => {
							delete e.envelope;
						},
					},
				});
			else
				for (const part of referencedParts(text))
					if (!hasPart(e, part))
						add(
							"e",
							"edge",
							k,
							T("chk.envelope.undeclared", { token: "{{x." + partToken(part) + "}}", part: partToken(part) }),
							{
								field: "parts",
								fix: {
									label: T("chk.envelope.undeclared.fix", { part: partToken(part) }),
									run: () => {
										e.x[part] = true;
									},
								},
							},
						);
			if (tr?.optimize && tr.optimize !== "verbatim")
				add("i", "edge", k, T("chk.transcript.helper", { model: boot.summaryModel ?? "@smol" }), {
					field: "parts",
				});
		} else if (to && (e.envelope !== undefined || tr))
			add("i", "edge", k, T("chk.verdict.inert"), {
				field: "envelope",
				fix: {
					label: T("chk.verdict.inert.fix"),
					run: () => {
						delete e.envelope;
						delete e.$inline;
						if (tr) e.x.transcript = true;
					},
				},
			});
	}
	const seen = reachable(),
		lt = limitTarget();
	if (node(mix.entry))
		for (const n of mix.members) if (!seen.has(n.id) && n !== lt) add("w", "node", n.id, T("chk.unreachable"));
	for (const loop of endlessLoops())
		add(
			"w",
			loop.edge ? "edge" : "mix",
			loop.edge?.$k ?? null,
			T("chk.cycle", { ids: [...loop.ids, loop.ids[0]].join(" → ") }),
			loop.edge && {
				field: "cap",
				fix: {
					label: T("chk.cycle.fix", { from: loop.edge.from, to: loop.edge.to }),
					run: () => {
						loop.edge.maxTraversals = 3;
					},
				},
			},
		);
	if (L.maxHops !== undefined && !posInt(L.maxHops)) add("e", "mix", null, T("chk.limits.hops"), { field: "limits" });
	else if (L.maxHops > D().hardMaxHops)
		add("e", "mix", null, T("chk.limits.exceeds", { n: L.maxHops, max: D().hardMaxHops }), { field: "limits" });
	if (L.budgetUsd !== undefined && !(Number.isFinite(L.budgetUsd) && L.budgetUsd >= 0))
		add("e", "mix", null, T("chk.limits.budget"), { field: "limits" });
	if (L.wallClockMinutes !== undefined && !(Number.isFinite(L.wallClockMinutes) && L.wallClockMinutes > 0))
		add("e", "mix", null, T("chk.limits.clock"), { field: "limits" });
	if (onLimit() === "judge") {
		const t = node(L.limitTarget),
			pick = models.find(n => !outs(n.id).length) ?? models.at(-1);
		if (!isModel(t))
			add("e", "mix", null, t ? T("chk.limits.targetVerdict") : T("chk.limits.target"), {
				field: "limits",
				...(pick && {
					fix: {
						label: T("chk.limits.target.fix", { id: pick.id }),
						run: () => {
							(mix.limits ??= {}).limitTarget = pick.id;
						},
					},
				}),
			});
	} else if (L.limitTarget)
		add("i", "mix", null, T("chk.limits.unused", { id: L.limitTarget, action: onLimit() }), {
			field: "limits",
			fix: {
				label: T("chk.limits.unused.fix"),
				run: () => {
					delete mix.limits.limitTarget;
				},
			},
		});
	return found;
}
/* The harness's findings for this mixture that the checks above do not already cover. */
function serverFindings() {
	const out = [];
	for (const it of server.issues) {
		const m = /^mixtures\[(\d+)\]\.?(.*)$/.exec(it.path);
		if (!m || server.map[+m[1]] !== cur.index || COVERED.has(it.code)) continue;
		const rest = m[2],
			at = /^(members|edges)\[(\d+)\]\.?(.*)$/.exec(rest);
		const target = at?.[1] === "members" ? mix.members[+at[2]] : at?.[1] === "edges" ? mix.edges[+at[2]] : null;
		const tail = at ? at[3] : rest,
			field = /^model/.test(tail)
				? "model"
				: /^(role|system)/.test(tail)
					? "prompt"
					: /^route/.test(tail)
						? "route"
						: /^terminate/.test(tail)
							? "stop"
							: /^question/.test(tail)
								? "question"
								: /^envelope/.test(tail)
									? "envelope"
									: /^x/.test(tail)
										? "parts"
										: /^limits/.test(tail)
											? "limits"
											: /^tools/.test(tail)
												? "tools"
												: undefined;
		out.push({
			sev: it.sev,
			kind: !target ? "mix" : at[1] === "members" ? "node" : "edge",
			id: !target ? null : at[1] === "members" ? target.id : target.$k,
			msg: it.message,
			field,
			server: true,
			code: it.code,
		});
	}
	return out;
}
const issuesFor = (kind, id) => issues.filter(i => i.kind === kind && (kind === "mix" || i.id === id));
const worst = list => (list.some(i => i.sev === "e") ? "e" : list.some(i => i.sev === "w") ? "w" : null);
/* Choices are edited as an ordered list, so a half-typed label cannot swallow its neighbour; criteria is rebuilt from it. */
function choicesOf(n) {
	return (n.question.$list ??= Object.entries(n.question.criteria ?? {}).map(([label, rubric]) => [
		label,
		rubric ?? "",
	]));
}
function writeChoices(n) {
	n.question.criteria = Object.fromEntries(
		choicesOf(n).map(([label, rubric]) => [label, rubric.trim() ? rubric : null]),
	);
}

/* ═══════════════════════════ EDITS ═══════════════════════════
   Every change goes through commit() (structural) or typing() (keystrokes, coalesced), so undo is one step per intent. */
const snapshot = () => JSON.stringify({ docs: [...files].map(([sid, f]) => [sid, f.doc]), cur, sel });
function restore(text) {
	const s = JSON.parse(text);
	for (const [sid, d] of s.docs) if (fileOf(sid)) fileOf(sid).doc = d;
	cur = s.cur;
	sel = s.sel;
	multi.clear();
	typingKey = null;
	sync();
	if (!mix) pickMixture();
}
function pushUndo(label) {
	undoStack.push({ label, state: snapshot() });
	if (undoStack.length > 200) undoStack.shift();
	redoStack.length = 0;
}
function commit(label, change, { quiet } = {}) {
	pushUndo(label);
	typingKey = null;
	const result = change();
	sync();
	edited();
	render();
	if (!quiet) toast(label, { undo: true });
	return result;
}
function typing(key, change) {
	if (typingKey !== key) {
		pushUndo(T("undo.edit"));
		typingKey = key;
	}
	change();
	edited();
	soft();
}
function undo() {
	const step = undoStack.pop();
	if (!step) return;
	redoStack.push({ label: step.label, state: snapshot() });
	restore(step.state);
	edited();
	render();
	toast(T("undo.undid", { label: step.label }));
}
function redo() {
	const step = redoStack.pop();
	if (!step) return;
	undoStack.push({ label: step.label, state: snapshot() });
	restore(step.state);
	edited();
	render();
	toast(T("undo.redid", { label: step.label }));
}

function uniqueEdgeId(e) {
	const taken = new Set(mix.edges.filter(x => x !== e).map(eid)),
		base = `${e.from}-${isFan(e) ? "fan" : e.to}`;
	return taken.has(base) || reservedEdge(base) ? freeId(base + "-", taken) : base;
}
/* Paths without an explicit ID are known by their endpoints, so anything that moves an endpoint must carry
   the “if unsure” reference of the model it leaves along with it. */
function keepingFallbacks(change) {
	const before = new Map(mix.edges.map(e => [e, { id: eid(e), from: e.from }]));
	change();
	for (const [e, was] of before) {
		const holder = mix.members.find(n => n.route?.fallback === was.id && (n.id === was.from || n.id === e.from));
		if (!holder || !mix.edges.includes(e)) continue;
		if (e.from === holder.id) holder.route.fallback = eid(e);
		else delete holder.route.fallback;
	}
}
function renameNode(n, to) {
	const from = n.id;
	let refs = 0;
	keepingFallbacks(() => {
		for (const e of mix.edges) {
			if (e.from === from) {
				e.from = to;
				refs++;
			}
			if (e.to === from) {
				e.to = to;
				refs++;
			}
			if (isFan(e) && e.to.includes(from)) {
				e.to = e.to.map(id => (id === from ? to : id));
				refs++;
			}
			if (e.join === from) {
				e.join = to;
				refs++;
			}
		}
		n.id = to;
	});
	if (mix.entry === from) {
		mix.entry = to;
		refs++;
	}
	if (mix.limits?.limitTarget === from) {
		mix.limits.limitTarget = to;
		refs++;
	}
	if (mix.steering?.target === from) {
		mix.steering.target = to;
		refs++;
	}
	if (selIs("node", from)) sel = { kind: "node", id: to };
	return refs;
}
function renameEdge(e, to) {
	keepingFallbacks(() => {
		to ? (e.id = to) : delete e.id;
	});
}
function addNode(kind, x, y) {
	const id = nextNodeId(kind);
	const n =
		kind === "verdict"
			? { id, kind: "verdict", question: { type: "noul", instructions: "" }, $x: x, $y: y }
			: {
					id,
					model: (boot.models.find(m => m.selector === "@task") ?? boot.models[0])?.selector ?? "",
					systemPrompt: "",
					tools: false,
					$x: x,
					$y: y,
				};
	mix.members.push(n);
	if (kind === "model" && !isModel(node(mix.entry))) mix.entry = id; // the first model becomes the start
	return n;
}
/* Adding a second path installs the route in the same step: one intent, one undo. */
function addEdge(from, to) {
	const source = node(from),
		before = liveOuts(from).length;
	const e = { from, to, x: { output: true }, $k: "k" + ++edgeSeq };
	mix.edges.push(e);
	if (mix.edges.some(x => x !== e && eid(x) === eid(e))) e.id = uniqueEdgeId(e);
	let routed = false;
	if (before === 1 && !source.route?.instructions?.trim()) {
		source.route = { ...source.route, instructions: starterRoute(from) };
		routed = true;
	}
	return { e, routed, count: before + 1 };
}
function removeEdge(e) {
	const source = node(e.from);
	if (source?.route?.fallback === eid(e)) delete source.route.fallback;
	mix.edges = mix.edges.filter(x => x !== e);
	if (selIs("edge", e.$k)) sel = source ? { kind: "node", id: source.id } : null;
}
function removeNode(n) {
	for (const e of [...mix.edges]) if (e.from === n.id || e.to === n.id) removeEdge(e);
	for (const e of [...mix.edges])
		if (isFan(e) && e.to.includes(n.id)) {
			e.to = e.to.filter(id => id !== n.id);
			if (!e.to.length) removeEdge(e);
		}
	mix.members = mix.members.filter(x => x !== n);
	if (mix.entry === n.id) mix.entry = mix.members.find(isModel)?.id ?? "";
	if (mix.limits?.limitTarget === n.id) delete mix.limits.limitTarget;
	if (mix.steering?.target === n.id) delete mix.steering;
	multi.delete(n.id);
	if (selIs("node", n.id)) sel = null;
}
function convertFanout(e) {
	const source = node(e.from),
		at = mix.edges.indexOf(e);
	const made = e.to.map(to => ({ from: e.from, to, x: clone(e.x ?? { output: true }), $k: "k" + ++edgeSeq }));
	mix.edges.splice(at, 1, ...made);
	for (const m of made) if (mix.edges.some(x => x !== m && eid(x) === eid(m))) m.id = uniqueEdgeId(m);
	if (made.length >= 2 && !source.route?.instructions)
		source.route = { ...source.route, instructions: starterRoute(source.id) };
	if (selIs("edge", e.$k)) sel = { kind: "node", id: source.id };
}
/* A limits table only exists while it holds something. */
function setLimit(key, value) {
	const L = (mix.limits ??= {});
	value === undefined || value === "" ? delete L[key] : (L[key] = value);
	if (!Object.keys(L).length) delete mix.limits;
}
