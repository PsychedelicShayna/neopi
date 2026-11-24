/* global document, window, fetch */

const byId = id => document.getElementById(id);
const messages = JSON.parse(byId("editor-i18n").textContent);
const locale = document.documentElement.lang;

function t(key, values) {
	const message = messages[key] ?? key;
	return values
		? message.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name) =>
				Object.hasOwn(values, name) ? String(values[name]) : placeholder,
			)
		: message;
}

const board = byId("board");
const inspector = byId("inspector");
const scopeInput = byId("scope");
const svgNS = "http://www.w3.org/2000/svg";
const transitParts = [
	["output", t("output")],
	["input", t("fittedInput")],
	["reasoning", t("reasoning")],
	["toolTrace", t("toolTrace")],
	["transcript", t("transcript")],
];
const modelShow = [
	["", t("default")],
	["always", t("always")],
	["never", t("never")],
	["final", t("finalOnly")],
];
let source;
let mixture;
let selection = { kind: "mixture" };
let connecting = false;
let dirty = false;
let busy = false;

function el(tag, text) {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	return node;
}

function svg(tag, attributes) {
	const node = document.createElementNS(svgNS, tag);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
	return node;
}

function button(text, action, options = {}) {
	const node = el("button", text);
	node.type = "button";
	if (options.danger) node.className = "danger";
	if (options.disabled) node.disabled = true;
	if (options.pressed !== undefined) node.setAttribute("aria-pressed", options.pressed);
	node.addEventListener("click", action);
	return node;
}

function status(text, error = false) {
	byId("status").textContent = text;
	byId("feedback").toggleAttribute("data-error", error);
}

function findings(validation, toml, parseDiagnostics = []) {
	const view = byId("findings");
	view.replaceChildren();
	for (const [label, diagnostics] of [
		[t("sourceWarnings"), source?.parseDiagnostics ?? []],
		[t("draftWarnings"), parseDiagnostics],
	]) {
		if (!diagnostics.length) continue;
		const list = el("ul");
		list.className = "warnings";
		for (const message of diagnostics) list.append(el("li", message));
		view.append(el("h3", label), list);
	}
	for (const [key, label] of [
		["errors", t("errors")],
		["warnings", t("warnings")],
	]) {
		const items = validation?.[key];
		if (!items?.length) continue;
		const list = el("ul");
		list.className = key;
		for (const item of items) {
			const row = el("li");
			row.append(el("code", item.path), `: ${item.message}`);
			list.append(row);
		}
		view.append(el("h3", label), list);
	}
	const preview = byId("preview");
	preview.hidden = toml === undefined;
	preview.querySelector("pre").textContent = toml ?? "";
}

function controls() {
	for (const id of [
		"reload",
		"scope",
		"validate",
		"save",
		"add-mixture",
		"document",
		"add-model",
		"add-verdict",
		"connect",
		"mixture-settings",
	]) {
		byId(id).disabled = busy || (id !== "reload" && !source);
	}
	byId("save").disabled ||= !dirty || Boolean(source?.readOnly);
	for (const id of ["add-model", "add-verdict", "connect", "mixture-settings"]) byId(id).disabled ||= !mixture;
	byId("connect").disabled ||= !connecting && (selection.kind !== "member" || selection.item.kind === "verdict");
	byId("connect").textContent = connecting
		? t("cancelConnection", { id: selection.item.id })
		: t("connectFromModel");
	byId("connect").setAttribute("aria-pressed", connecting);
	inspector.inert = busy;
	board.inert = busy;
	byId("mixtures").inert = busy;
}

function changed() {
	dirty = true;
	findings();
	status(t("unsavedChanges"));
	controls();
}

async function request(route, method, value) {
	const url = new URL(route, window.location.href);
	url.searchParams.set("lang", locale);
	const response = await fetch(
		url,
		method && {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(value),
		},
	);
	const result = await response.json();
	if (!response.ok)
		throw Object.assign(new Error(result.error ?? t("requestFailed")), {
			code: result.code,
			parseDiagnostics: result.parseDiagnostics,
			validation: result.validation,
		});
	return result;
}

async function load(scope) {
	if (busy) return;
	if (dirty && !window.confirm(t("discardChanges"))) {
		scopeInput.value = source.scope;
		return;
	}
	busy = true;
	controls();
	try {
		const result = await request(scope ? `mixtures?scope=${scope}` : "mixtures");
		const previous = source?.scope === result.scope ? mixture?.name : undefined;
		source = result;
		dirty = false;
		mixture = source.doc.mixtures.find(item => item.name === previous) ?? source.doc.mixtures[0];
		selection = { kind: "mixture" };
		connecting = false;
		scopeInput.value = source.scope;
		byId("source").textContent = source.sourcePath;
		byId("source").title = t("sourceLocation", { cwd: source.cwd, destination: source.sourcePath });
		byId("models").replaceChildren(
			...source.models.map(name => {
				const option = el("option");
				option.value = name;
				return option;
			}),
		);
		redraw();
		findings(source.validation, source.parseDiagnostics.length ? source.toml : undefined);
		status(
			source.readOnly
				? t("readOnly", { reason: source.readOnly })
				: source.parseDiagnostics.length
					? t("loadedWithWarnings")
					: source.hash
						? t("loaded")
						: t("noSource"),
		);
	} catch (error) {
		if (source) scopeInput.value = source.scope;
		status(error.message, true);
	} finally {
		busy = false;
		controls();
	}
}

async function submit(save) {
	if (busy || !source) return;
	const invalid = inspector.querySelector("input:invalid");
	if (invalid) {
		const details = invalid.closest("details");
		if (details) details.open = true;
		invalid.reportValidity();
		status(t("fixInvalidDraft"), true);
		return;
	}
	busy = true;
	controls();
	try {
		const { scope, doc, hash } = source;
		const send = (confirmCanonicalRewrite = false) =>
			request(save ? "mixtures" : "mixtures/draft", save ? "PUT" : "POST", {
				scope,
				doc,
				...(save ? { baseHash: hash, confirmCanonicalRewrite } : {}),
			});
		let result;
		try {
			result = await send();
		} catch (error) {
			if (!save || error.code !== "rewrite-loses-source") throw error;
			const diagnostics = error.parseDiagnostics.join("\n");
			if (!window.confirm(t("confirmRewrite", { message: error.message, diagnostics }))) {
				status(t("saveCancelled"));
				return;
			}
			result = await send(true);
		}
		if (save) {
			source.hash = result.hash;
			source.parseDiagnostics = result.parseDiagnostics;
			delete doc.warnings;
			dirty = false;
			status(t(result.registered ? "saved" : "savedShadowed"));
		} else status(t("draftValid"));
		findings(result.validation, result.toml, save ? [] : result.parseDiagnostics);
	} catch (error) {
		findings(error.validation, undefined, error.code === "rewrite-loses-source" ? [] : error.parseDiagnostics);
		status(error.message, true);
	} finally {
		busy = false;
		controls();
	}
}

function choose(kind, item) {
	const focused = board.contains(document.activeElement) ? board : byId("mixtures");
	const restoreFocus = focused.contains(document.activeElement);
	selection = { kind, item };
	connecting = false;
	redraw();
	if (restoreFocus) focused.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
}

function renderRail() {
	const list = byId("mixtures");
	list.replaceChildren(
		...(source?.doc.mixtures ?? []).map(item =>
			button(
				item.name,
				() => {
					mixture = item;
					choose("mixture");
				},
				{ pressed: mixture === item && selection.kind !== "document" },
			),
		),
	);
	byId("document").setAttribute("aria-pressed", selection.kind === "document");
}

function edgeId(edge) {
	return edge.id ?? `${edge.from}->${Array.isArray(edge.to) ? `[${edge.to.join(",")}]` : edge.to}`;
}

function layout(graph) {
	const depth = new Map();
	const entry = graph.members.find(member => member.id === graph.entry);
	const queue = [];
	if (entry) {
		queue.push(entry.id);
		depth.set(entry.id, 0);
	}
	for (const id of queue) {
		for (const edge of graph.edges.filter(item => item.from === id)) {
			for (const target of [edge.to].flat()) {
				if (depth.has(target)) continue;
				depth.set(target, depth.get(id) + 1);
				queue.push(target);
			}
		}
	}
	const orphan = depth.size ? Math.max(...depth.values()) + 1 : 0;
	const rows = new Map();
	return new Map(
		graph.members.map(member => {
			const column = depth.get(member.id) ?? orphan;
			const row = rows.get(column) ?? 0;
			rows.set(column, row + 1);
			return [member.id, { x: 45 + column * 255, y: 72 + row * 120 }];
		}),
	);
}

function wire(from, to, gap) {
	if (from === to) {
		const y = from.y - 34 - gap;
		return {
			d: `M ${from.x + 101} ${from.y} C ${from.x + 120} ${y} ${from.x + 24} ${y} ${from.x + 49} ${from.y}`,
			x: from.x + 75,
			y,
		};
	}
	if (to.x > from.x) {
		const x = (from.x + 158 + to.x) / 2;
		return {
			d: `M ${from.x + 158} ${from.y + 32} Q ${x} ${(from.y + to.y) / 2 + 32 + gap * 2} ${to.x} ${to.y + 32}`,
			x,
			y: (from.y + to.y) / 2 + 32 + gap,
		};
	}
	const y = Math.max(from.y, to.y) + 90 + gap;
	return {
		d: `M ${from.x + 105} ${from.y + 64} C ${from.x + 105} ${y + 18} ${to.x + 55} ${y + 18} ${to.x + 55} ${to.y + 64}`,
		x: (from.x + to.x) / 2 + 80,
		y,
	};
}

function connectTo(member) {
	const from = selection.item.id;
	const duplicate = mixture.edges.filter(edge => edge.from === from && edge.to === member.id).length;
	const edge = { from, to: member.id, x: { output: true } };
	if (duplicate) {
		const used = mixture.edges.map(edgeId);
		edge.id = unusedId(`${from}->${member.id}`, used);
	}
	mixture.edges.push(edge);
	changed();
	choose("edge", edge);
}

function renderGraph() {
	board.replaceChildren();
	const note = byId("graph-note");
	if (!mixture?.members.length) {
		const empty = el("p", t(mixture ? "addEntryModel" : "selectOrCreateMixture"));
		empty.className = "empty";
		board.append(empty);
		board.style.width = "";
		board.style.height = "";
		note.textContent = t("flowExplanation");
		return;
	}
	const points = layout(mixture);
	const width = Math.max(...Array.from(points.values(), point => point.x)) + 205;
	const height = Math.max(...Array.from(points.values(), point => point.y)) + 170;
	board.style.width = `${width}px`;
	board.style.height = `${height}px`;
	const drawing = svg("svg", { width, height, "aria-hidden": "true" });
	const defs = svg("defs", {});
	const arrow = svg("marker", {
		id: "arrow",
		viewBox: "0 0 10 10",
		refX: 9,
		refY: 5,
		markerWidth: 7,
		markerHeight: 7,
		orient: "auto",
	});
	arrow.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#83dfec" }));
	defs.append(arrow);
	drawing.append(defs);
	board.append(drawing);
	const offsets = new Map();
	for (const edge of mixture.edges) {
		const from = points.get(edge.from);
		const targets = [edge.to].flat();
		const pair = JSON.stringify([edge.from, edge.to]);
		const gap = offsets.get(pair) ?? 0;
		offsets.set(pair, gap + 16);
		let label;
		for (const target of targets) {
			const to = points.get(target);
			if (!from || !to) continue;
			const curve = wire(from, to, gap);
			label ??= curve;
			drawing.append(
				svg("path", {
					d: curve.d,
					fill: "none",
					stroke: selection.item === edge ? "#f4a3dd" : "#83dfec",
					"stroke-width": 1.8,
					"marker-end": "url(#arrow)",
					...(Array.isArray(edge.to) ? { "stroke-dasharray": "6 5" } : {}),
				}),
			);
		}
		if (!label) label = { x: 110, y: 22 + mixture.edges.indexOf(edge) * 24 };
		const title = edge.when || edgeId(edge);
		const node = button(title, () => choose("edge", edge), { pressed: selection.item === edge });
		node.className = "edge";
		node.toggleAttribute("data-gated", Array.isArray(edge.to));
		node.title = `${edge.from} → ${targets.join(", ")}${edge.when ? `: ${edge.when}` : ""}`;
		node.setAttribute("aria-label", t("handoffDescription", { handoff: node.title }));
		node.style.left = `${label.x}px`;
		node.style.top = `${label.y}px`;
		board.append(node);
	}
	for (const member of mixture.members) {
		const { x, y } = points.get(member.id);
		const entry = member.id === mixture.entry;
		const model =
			member.kind === "verdict" ? t("verdictOfType", { type: member.question.type }) : member.model || t("chooseModel");
		const node = button("", () => (connecting ? connectTo(member) : choose("member", member)), {
			pressed: selection.item === member,
		});
		node.className = "tile";
		node.dataset.kind = member.kind ?? "model";
		node.toggleAttribute("data-entry", entry);
		node.title = `${member.id}: ${model}`;
		node.style.left = `${x}px`;
		node.style.top = `${y}px`;
		node.append(el("strong", member.id), el("small", entry ? t("entryLabel", { model }) : model));
		board.append(node);
	}
	note.textContent = connecting
		? t("chooseDestination", { id: selection.item.id })
		: t("editNodeHint");
}

function field(label, value, apply, options = {}) {
	const wrap = el("label", label);
	const node = el(options.choices ? "select" : options.multiline ? "textarea" : "input");
	if (options.choices) {
		for (const [key, text] of options.choices) {
			const option = el("option", text);
			option.value = key;
			node.append(option);
		}
	} else if (!options.multiline) node.type = options.numeric ? "number" : "text";
	if (options.list) node.setAttribute("list", options.list);
	if (options.placeholder) node.placeholder = options.placeholder;
	if (options.numeric) {
		node.step = options.numeric === "integer" ? "1" : "any";
		if (options.min !== undefined) node.min = options.min;
		if (options.max !== undefined) node.max = options.max;
	}
	node.value = value ?? "";
	node.addEventListener(options.choices || options.commit ? "change" : "input", () => {
		if (options.numeric && !node.validity.valid) {
			node.reportValidity();
			return;
		}
		const result = apply(options.numeric && node.value !== "" ? Number(node.value) : node.value, node);
		if (result !== false) changed();
	});
	wrap.append(node);
	return wrap;
}

function property(root, label, target, key, options = {}) {
	root.append(
		field(
			label,
			target[key],
			value => {
				if (value === "" && !options.keepEmpty) delete target[key];
				else target[key] = value;
				options.after?.();
			},
			options,
		),
	);
}

function check(label, checked, apply, disabled = false) {
	const wrap = el("label");
	wrap.className = "check";
	const box = el("input");
	box.type = "checkbox";
	box.checked = checked;
	box.disabled = disabled;
	box.addEventListener("change", () => {
		apply(box.checked);
		changed();
	});
	wrap.append(box, label);
	return wrap;
}

function details(title, note) {
	const panel = el("details");
	panel.append(el("summary", title));
	if (note) panel.append(el("p", note));
	return panel;
}

function unusedId(base, used) {
	if (!used.includes(base)) return base;
	let i = 2;
	while (used.includes(`${base}-${i}`)) i++;
	return `${base}-${i}`;
}

function remove(target, item) {
	target.splice(target.indexOf(item), 1);
	changed();
	choose("mixture");
}

function presets(root, target, key, title) {
	const panel = details(title, t("presetsExplanation"));
	const render = () => {
		while (panel.children.length > 2) panel.lastElementChild.remove();
		for (const [name, value] of Object.entries(target[key] ?? {})) {
			const row = el("div");
			row.className = "presets";
			row.append(
				el("code", name),
				field(
					t("text"),
					value,
					text => {
						target[key][name] = text;
					},
					{ multiline: true },
				),
			);
			row.append(
				button(
					t("removePreset"),
					() => {
						delete target[key][name];
						if (!Object.keys(target[key]).length) delete target[key];
						changed();
						render();
					},
					{ danger: true },
				),
			);
			panel.append(row);
		}
		panel.append(
			button(t("addPreset"), () => {
				const name = window.prompt(t("presetName"))?.trim();
				if (!name) return;
				if (Object.hasOwn(target[key] ?? {}, name)) {
					status(t("duplicatePreset", { name }), true);
					return;
				}
				target[key] = { ...target[key], [name]: "" };
				changed();
				render();
			}),
		);
	};
	render();
	root.append(panel);
}

function settingsPanel() {
	inspector.append(el("h2", t("mixtureSettings")));
	inspector.append(
		field(
			t("name"),
			mixture.name,
			(value, input) => {
				const name = value.trim();
				if (
					!/^[a-z0-9][a-z0-9._-]*$/.test(name) ||
					source.doc.mixtures.some(item => item !== mixture && item.name === name)
				) {
					input.value = mixture.name;
					status(t("invalidMixtureName"), true);
					return false;
				}
				mixture.name = name;
				input.value = name;
				renderRail();
			},
			{ commit: true },
		),
	);
	property(inspector, t("description"), mixture, "description", { multiline: true });
	const models = mixture.members.filter(member => member.kind !== "verdict").map(member => [member.id, member.id]);
	inspector.append(
		field(
			t("entryModel"),
			mixture.entry,
			value => {
				mixture.entry = value;
				renderGraph();
			},
			{ choices: [["", t("chooseEntry")], ...models] },
		),
	);
	const limits = details(t("limits"), t("limitsExplanation"));
	const draft = { ...mixture.limits };
	const useLimits = () => {
		if (Object.keys(draft).length) mixture.limits = draft;
		else delete mixture.limits;
	};
	property(limits, t("maxHops"), draft, "maxHops", { numeric: "integer", min: 1, after: useLimits });
	property(limits, t("spendBudget"), draft, "budgetUsd", {
		numeric: "decimal",
		min: 0,
		after: useLimits,
	});
	property(limits, t("wallClock"), draft, "wallClockMinutes", {
		numeric: "decimal",
		min: 0,
		after: useLimits,
	});
	property(limits, t("onLimit"), draft, "onLimit", {
		choices: [
			["", t("default")],
			["pause", t("pause")],
			["stop", t("stop")],
			["judge", t("askFinalModel")],
		],
		after: useLimits,
	});
	property(limits, t("limitModel"), draft, "limitTarget", { choices: [["", t("default")], ...models], after: useLimits });
	inspector.append(limits);
	presets(inspector, mixture, "roles", t("localRolePresets"));
	presets(inspector, mixture, "envelopes", t("localEnvelopePresets"));
	const gate = el("div");
	gate.className = "gate";
	gate.append(
		check(t("steeringGate"), !!mixture.steering, () => {}, true),
		check(
			t("fanOutGate"),
			mixture.edges.some(edge => Array.isArray(edge.to)),
			() => {},
			true,
		),
		check(t("gatewayGate"), mixture.serve === true, () => {}, true),
	);
	if (mixture.steering || mixture.serve)
		gate.append(
			button(t("clearGated"), () => {
				delete mixture.steering;
				if (mixture.serve) delete mixture.serve;
				changed();
				renderInspector();
			}),
		);
	inspector.append(gate);
	inspector.append(
		button(
			t("deleteMixture"),
			() => {
				if (!window.confirm(t("confirmDeleteMixture", { name: mixture.name }))) return;
				const old = mixture;
				mixture = source.doc.mixtures.find(item => item !== old);
				remove(source.doc.mixtures, old);
			},
			{ danger: true },
		),
	);
}

function stateParts(root, target, parts) {
	const group = el("fieldset");
	group.append(el("legend", t("stateParts")));
	group.append(
		check(t("explicitState"), target.state !== undefined, explicit => {
			if (explicit) target.state = parts.map(([part]) => part);
			else delete target.state;
			for (const box of [...group.querySelectorAll("input")].slice(1)) {
				box.disabled = !explicit;
				box.checked = explicit;
			}
		}),
	);
	for (const [part, label] of parts)
		group.append(
			check(
				label,
				target.state?.includes(part),
				checked => {
					target.state = checked ? [...target.state, part] : target.state.filter(item => item !== part);
				},
				target.state === undefined,
			),
		);
	root.append(group);
}

function rubrics(root, target) {
	const rows = el("div");
	const render = () => {
		rows.replaceChildren();
		if (target.type === "noul" || target.type === undefined) {
			for (const [key, label] of [
				["true", t("yesRubric")],
				["false", t("noRubric")],
			])
				rows.append(
					field(
						label,
						target.criteria?.[key],
						value => {
							if (value) (target.criteria ??= {})[key] = value;
							else if (target.criteria) {
								delete target.criteria[key];
								if (Object.keys(target.criteria).length === 0) delete target.criteria;
							}
						},
						{ multiline: true },
					),
				);
			return;
		}
		const score = target.type === "score";
		for (const [key, value] of Object.entries(target.criteria)) {
			const row = el("div");
			row.className = "presets";
			row.append(
				field(
					score ? t("scoreLevel", { level: key }) : key,
					value,
					text => {
						target.criteria[key] = score ? text : text.trim() ? text : null;
					},
					{ multiline: true },
				),
			);
			row.append(
				button(
					t("removeRubric"),
					() => {
						if (score) target.criteria.splice(Number(key), 1);
						else delete target.criteria[key];
						changed();
						render();
					},
					{ danger: true, disabled: Object.keys(target.criteria).length <= 2 },
				),
			);
			rows.append(row);
		}
		rows.append(
			button(t(score ? "addLevel" : "addChoice"), () => {
				if (score) target.criteria.push("");
				else {
					const label = window.prompt(t("choiceLabel"))?.trim();
					if (!label || Object.hasOwn(target.criteria, label)) return;
					target.criteria = { ...target.criteria, [label]: null };
				}
				changed();
				render();
			}),
		);
	};
	render();
	root.append(rows);
}

function condition(member, key, title, note, addLabel) {
	const panel = details(title, note);
	const render = () => {
		while (panel.children.length > 2) panel.lastElementChild.remove();
		const target = member[key];
		if (!target) {
			panel.append(
				button(addLabel, () => {
					member[key] = { instructions: "" };
					changed();
					render();
				}),
			);
			return;
		}
		property(panel, t("instructions"), target, "instructions", { multiline: true, keepEmpty: true });
		stateParts(
			panel,
			target,
			transitParts.filter(([part]) => ["output", "input", "toolTrace"].includes(part)),
		);
		if (key === "route") {
			property(panel, t("minConfidence"), target, "minConfidence", { numeric: "decimal", min: 0, max: 1 });
			property(panel, t("fallback"), target, "fallback", {
				choices: [
					["", t("defaultPause")],
					["pause", t("pause")],
					...mixture.edges.filter(edge => edge.from === member.id).map(edge => [edgeId(edge), edgeId(edge)]),
				],
			});
		} else {
			property(panel, t("yesThreshold"), target, "threshold", { numeric: "decimal", min: 0, max: 1 });
			rubrics(panel, target);
		}
		panel.append(
			button(
				t("removeCondition"),
				() => {
					delete member[key];
					changed();
					render();
				},
				{ danger: true },
			),
		);
	};
	render();
	panel.open = !!member[key];
	inspector.append(panel);
}

function memberPanel(member) {
	inspector.append(el("h2", t(member.kind === "verdict" ? "verdictNode" : "modelNode")));
	inspector.append(
		field(
			t("memberId"),
			member.id,
			(value, input) => {
				const id = value.trim();
				if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || mixture.members.some(item => item !== member && item.id === id)) {
					input.value = member.id;
					status(t("invalidMemberId"), true);
					return false;
				}
				const old = member.id;
				for (const edge of mixture.edges) {
					const before = edgeId(edge);
					if (edge.from === old) edge.from = id;
					if (Array.isArray(edge.to)) {
						edge.to = edge.to.map(target => (target === old ? id : target));
						if (edge.join === old) edge.join = id;
					} else if (edge.to === old) edge.to = id;
					for (const node of mixture.members)
						if (node.route?.fallback === before) node.route.fallback = edgeId(edge);
				}
				if (mixture.entry === old) mixture.entry = id;
				if (mixture.limits?.limitTarget === old) mixture.limits.limitTarget = id;
				if (mixture.steering?.target === old) mixture.steering.target = id;
				member.id = id;
				input.value = id;
				renderGraph();
			},
			{ commit: true },
		),
	);
	property(inspector, t("description"), member, "description", { multiline: true });
	property(inspector, t("intermediateVisibility"), member, "show", { choices: modelShow });
	if (member.kind === "verdict") {
		property(inspector, t("questionType"), member.question, "type", {
			choices: [
				["noul", t("yesNo")],
				["choice", t("choice")],
				["score", t("score")],
			],
			after: () => {
				const type = member.question.type;
				if (type === "noul") delete member.question.criteria;
				else member.question.criteria = type === "score" ? ["", ""] : { first: null, second: null };
				renderInspector();
				renderGraph();
			},
		});
		property(inspector, t("questionInstructions"), member.question, "instructions", {
			keepEmpty: true,
			multiline: true,
		});
		rubrics(inspector, member.question);
		stateParts(inspector, member, transitParts);
		property(inspector, t("renderEnvelope"), member, "render", { multiline: true, placeholder: "verdict" });
	} else {
		inspector.append(
			button(
				t(mixture.entry === member.id ? "entryModel" : "setEntry"),
				() => {
					mixture.entry = member.id;
					changed();
					redraw();
				},
				{ disabled: mixture.entry === member.id },
			),
		);
		property(inspector, t("modelSelector"), member, "model", {
			keepEmpty: true,
			list: "models",
			placeholder: t("modelPlaceholder"),
			after: renderGraph,
		});
		property(inspector, t("rolePreset"), member, "role");
		inspector.append(
			check(t("useInlineSystemPrompt"), member.systemPrompt !== undefined, enabled => {
				if (enabled) member.systemPrompt = "";
				else delete member.systemPrompt;
				renderInspector();
			}),
		);
		if (member.systemPrompt !== undefined)
			property(inspector, t("systemPrompt"), member, "systemPrompt", { keepEmpty: true, multiline: true });
		inspector.append(
			field(
				t("inheritPrompt"),
				String(member.inherit ?? ""),
				value => {
					if (value === "") delete member.inherit;
					else member.inherit = value === "true";
				},
				{
					choices: [
						["", t("default")],
						["true", t("yes")],
						["false", t("no")],
					],
				},
			),
		);
		property(inspector, t("maxOutputTokens"), member, "maxTokens", { numeric: "integer", min: 1 });
		condition(
			member,
			"route",
			t("routing"),
			t("routingExplanation"),
			t("addRouting"),
		);
		condition(
			member,
			"terminate",
			t("termination"),
			t("terminationExplanation"),
			t("addTermination"),
		);
		const gate = el("div");
		gate.className = "gate";
		gate.append(check(t("callerToolsGate"), member.tools !== false && member.tools !== undefined, () => {}, true));
		if (member.tools !== false)
			gate.append(
				button(t("disableTools"), () => {
					member.tools = false;
					changed();
					renderInspector();
				}),
			);
		inspector.append(gate);
	}
	inspector.append(
		button(
			t("deleteMember"),
			() => {
				if (!window.confirm(t("confirmDeleteMember", { id: member.id }))) return;
				const deleted = new Set(
					mixture.edges
						.filter(
							edge => edge.from === member.id || [edge.to].flat().includes(member.id) || edge.join === member.id,
						)
						.map(edgeId),
				);
				mixture.edges = mixture.edges.filter(edge => !deleted.has(edgeId(edge)));
				for (const node of mixture.members) if (deleted.has(node.route?.fallback)) delete node.route.fallback;
				if (mixture.entry === member.id)
					mixture.entry = mixture.members.find(item => item !== member && item.kind !== "verdict")?.id ?? "";
				if (mixture.limits?.limitTarget === member.id) {
					delete mixture.limits.limitTarget;
					if (!Object.keys(mixture.limits).length) delete mixture.limits;
				}
				remove(mixture.members, member);
			},
			{ danger: true },
		),
	);
}

function edgePanel(edge) {
	inspector.append(el("h2", t("handoff")), el("p", `${edge.from} → ${[edge.to].flat().join(", ")}`));
	if (Array.isArray(edge.to)) {
		inspector.append(el("p", t("fanOutHint")));
	} else {
		const fallback = mixture.members.find(member => member.id === edge.from)?.route;
		const updateEdge = (key, value) => {
			const old = edgeId(edge);
			if (value === "" && key === "id") delete edge.id;
			else edge[key] = value;
			if (fallback?.fallback === old) fallback.fallback = edgeId(edge);
			renderGraph();
		};
		inspector.append(
			field(t("optionalEdgeId"), edge.id, value => updateEdge("id", value.trim()), {
				commit: true,
				placeholder: edgeId(edge),
			}),
		);
		const edges = el("fieldset");
		edges.append(el("legend", t("transitParts")));
		for (const [part, label] of transitParts)
			edges.append(
				check(
					label,
					!!edge.x[part],
					checked => {
						if (checked) edge.x[part] = true;
						else delete edge.x[part];
					},
					false,
				),
			);
		inspector.append(edges);
		const transcript = details(t("transcriptOptions"), t("transcriptExplanation"));
		for (const [title, key, options] of [
			[
				t("optimization"),
				"optimize",
				{
					choices: [
						["", t("default")],
						["verbatim", t("verbatim")],
						["compact", t("compact")],
						["snapcompact", t("snapcompact")],
					],
				},
			],
			[t("tokenBudget"), "budgetTokens", { numeric: "integer", min: 1 }],
		]) {
			transcript.append(
				field(
					title,
					edge.x.transcript?.[key],
					value => {
						const spec = { ...(edge.x.transcript === true ? {} : edge.x.transcript) };
						if (value === "") delete spec[key];
						else spec[key] = value;
						edge.x.transcript = Object.keys(spec).length ? spec : true;
						edges.querySelector("label:last-child input").checked = true;
					},
					options,
				),
			);
		}
		inspector.append(transcript);
		property(inspector, t("whenRubric"), edge, "when", { multiline: true, after: renderGraph });
		property(inspector, t("envelope"), edge, "envelope", { multiline: true, placeholder: "handoff" });
		property(inspector, t("traversalCap"), edge, "maxTraversals", { numeric: "integer", min: 0 });
		property(inspector, t("visibilityOverride"), edge, "show", { choices: modelShow.slice(0, 3) });
	}
	inspector.append(
		button(
			t("deleteHandoff"),
			() => {
				const route = mixture.members.find(member => member.id === edge.from)?.route;
				if (route?.fallback === edgeId(edge)) delete route.fallback;
				remove(mixture.edges, edge);
			},
			{ danger: true },
		),
	);
}

function renderInspector() {
	inspector.replaceChildren();
	if (selection.kind === "document" && source) {
		inspector.append(el("h2", t("filePresets")), el("p", t("filePresetsExplanation")));
		presets(inspector, source.doc, "roles", t("rolePresets"));
		presets(inspector, source.doc, "envelopes", t("envelopePresets"));
	} else if (!mixture) inspector.append(el("p", t("selectMixtureToInspect")));
	else if (selection.kind === "member") memberPanel(selection.item);
	else if (selection.kind === "edge") edgePanel(selection.item);
	else settingsPanel();
}

function redraw() {
	renderRail();
	renderGraph();
	renderInspector();
	controls();
}

function addMember(verdict) {
	const id = unusedId(
		verdict ? "verdict" : "model",
		mixture.members.map(item => item.id),
	);
	const member = verdict
		? { kind: "verdict", id, question: { type: "noul", instructions: "" } }
		: { id, model: "", systemPrompt: "", tools: false };
	mixture.members.push(member);
	if (!mixture.entry && !verdict) mixture.entry = id;
	changed();
	choose("member", member);
	inspector.querySelector(verdict ? "textarea" : "[list=models]")?.focus();
}

scopeInput.addEventListener("change", () => void load(scopeInput.value));
byId("reload").addEventListener("click", () => void load(source?.scope));
byId("validate").addEventListener("click", () => void submit(false));
byId("save").addEventListener("click", () => void submit(true));
byId("add-mixture").addEventListener("click", () => {
	mixture = {
		name: unusedId(
			"new-mixture",
			source.doc.mixtures.map(item => item.name),
		),
		entry: "",
		members: [],
		edges: [],
	};
	source.doc.mixtures.push(mixture);
	changed();
	choose("mixture");
	inspector.querySelector("input")?.select();
});
byId("document").addEventListener("click", () => choose("document"));
byId("mixture-settings").addEventListener("click", () => choose("mixture"));
byId("add-model").addEventListener("click", () => addMember(false));
byId("add-verdict").addEventListener("click", () => addMember(true));
byId("connect").addEventListener("click", () => {
	connecting = !connecting;
	renderGraph();
	controls();
});
window.addEventListener("beforeunload", event => {
	if (dirty) event.preventDefault();
});
void load();
