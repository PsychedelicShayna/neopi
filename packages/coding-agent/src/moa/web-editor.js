/* global document, window, fetch */

const byId = id => document.getElementById(id);
const board = byId("board");
const inspector = byId("inspector");
const scopeInput = byId("scope");
const svgNS = "http://www.w3.org/2000/svg";
const transitParts = [
	["output", "Output"],
	["input", "Fitted input"],
	["reasoning", "Reasoning"],
	["toolTrace", "Tool trace"],
	["transcript", "Transcript"],
];
const modelShow = [
	["", "Default"],
	["always", "Always"],
	["never", "Never"],
	["final", "Final only"],
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
		["Source warnings", source?.parseDiagnostics ?? []],
		["Draft warnings", parseDiagnostics],
	]) {
		if (!diagnostics.length) continue;
		const list = el("ul");
		list.className = "warnings";
		for (const message of diagnostics) list.append(el("li", message));
		view.append(el("h3", label), list);
	}
	for (const [key, label] of [
		["errors", "Errors"],
		["warnings", "Warnings"],
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
		? `Cancel connection from ${selection.item.id}`
		: "Connect from selected model";
	byId("connect").setAttribute("aria-pressed", connecting);
	inspector.inert = busy;
	board.inert = busy;
	byId("mixtures").inert = busy;
}

function changed() {
	dirty = true;
	findings();
	status("Unsaved changes.");
	controls();
}

async function request(route, method, value) {
	const response = await fetch(
		route,
		method && {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(value),
		},
	);
	const result = await response.json();
	if (!response.ok)
		throw Object.assign(new Error(result.error ?? "The request failed."), {
			code: result.code,
			parseDiagnostics: result.parseDiagnostics,
			validation: result.validation,
		});
	return result;
}

async function load(scope) {
	if (busy) return;
	if (dirty && !window.confirm("Discard unsaved changes to this file?")) {
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
		byId("source").title = `Workspace: ${source.cwd}\nDestination: ${source.sourcePath}`;
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
				? `Read-only: ${source.readOnly}`
				: source.parseDiagnostics.length
					? "Loaded with source warnings. Saving requires confirmation."
					: source.hash
						? "Loaded MIXTURES.toml."
						: "This scope has no MIXTURES.toml yet. Add a mixture to start.",
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
		status("Fix the invalid value before submitting the draft.", true);
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
			if (!window.confirm(`${error.message}.\n\n${diagnostics}\n\nSave NeoPi's canonical form anyway?`)) {
				status("Save cancelled. The source file was not changed.");
				return;
			}
			result = await send(true);
		}
		if (save) {
			source.hash = result.hash;
			source.parseDiagnostics = result.parseDiagnostics;
			delete doc.warnings;
			dirty = false;
			status(
				result.registered
					? "Saved. The workspace roster is up to date."
					: "Saved. Higher-priority definitions still take precedence.",
			);
		} else status("The draft passes NeoPi validation.");
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
		const empty = el(
			"p",
			mixture ? "Add a model to give this mixture an entry point." : "Select or create a mixture to draw its flow.",
		);
		empty.className = "empty";
		board.append(empty);
		board.style.width = "";
		board.style.height = "";
		note.textContent = "A mixture starts at one model and passes state along directed handoffs.";
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
		node.setAttribute("aria-label", `Handoff: ${node.title}`);
		node.style.left = `${label.x}px`;
		node.style.top = `${label.y}px`;
		board.append(node);
	}
	for (const member of mixture.members) {
		const { x, y } = points.get(member.id);
		const entry = member.id === mixture.entry;
		const model = member.kind === "verdict" ? `${member.question.type} verdict` : member.model || "Choose a model";
		const node = button("", () => (connecting ? connectTo(member) : choose("member", member)), {
			pressed: selection.item === member,
		});
		node.className = "tile";
		node.dataset.kind = member.kind ?? "model";
		node.toggleAttribute("data-entry", entry);
		node.title = `${member.id}: ${model}`;
		node.style.left = `${x}px`;
		node.style.top = `${y}px`;
		node.append(el("strong", member.id), el("small", entry ? `Entry · ${model}` : model));
		board.append(node);
	}
	note.textContent = connecting
		? `Choose a destination for ${selection.item.id}; choose the same model to create a loop.`
		: "Select a node or handoff to edit it. The cyan entry receives the operator prompt.";
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
	const panel = details(
		title,
		"A mixture can override file presets of the same name. Preset names and template text are case-sensitive.",
	);
	const render = () => {
		while (panel.children.length > 2) panel.lastElementChild.remove();
		for (const [name, value] of Object.entries(target[key] ?? {})) {
			const row = el("div");
			row.className = "presets";
			row.append(
				el("code", name),
				field(
					"Text",
					value,
					text => {
						target[key][name] = text;
					},
					{ multiline: true },
				),
			);
			row.append(
				button(
					"Remove preset",
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
			button("Add preset", () => {
				const name = window.prompt("Preset name")?.trim();
				if (!name) return;
				if (Object.hasOwn(target[key] ?? {}, name)) {
					status(`The preset '${name}' already exists.`, true);
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
	inspector.append(el("h2", "Mixture settings"));
	inspector.append(
		field(
			"Name",
			mixture.name,
			(value, input) => {
				const name = value.trim();
				if (
					!/^[a-z0-9][a-z0-9._-]*$/.test(name) ||
					source.doc.mixtures.some(item => item !== mixture && item.name === name)
				) {
					input.value = mixture.name;
					status(
						"Enter a unique mixture name using lowercase letters, digits, periods, underscores or hyphens.",
						true,
					);
					return false;
				}
				mixture.name = name;
				input.value = name;
				renderRail();
			},
			{ commit: true },
		),
	);
	property(inspector, "Description", mixture, "description", { multiline: true });
	const models = mixture.members.filter(member => member.kind !== "verdict").map(member => [member.id, member.id]);
	inspector.append(
		field(
			"Entry model",
			mixture.entry,
			value => {
				mixture.entry = value;
				renderGraph();
			},
			{ choices: [["", "Choose an entry"], ...models] },
		),
	);
	const limits = details(
		"Limits",
		"Blank values inherit the invoking session's MoA settings. Hard lifetime caps still apply.",
	);
	const draft = { ...mixture.limits };
	const useLimits = () => {
		if (Object.keys(draft).length) mixture.limits = draft;
		else delete mixture.limits;
	};
	property(limits, "Maximum hops", draft, "maxHops", { numeric: "integer", min: 1, after: useLimits });
	property(limits, "Spend budget (USD; 0 disables)", draft, "budgetUsd", {
		numeric: "decimal",
		min: 0,
		after: useLimits,
	});
	property(limits, "Wall clock (minutes)", draft, "wallClockMinutes", {
		numeric: "decimal",
		min: 0,
		after: useLimits,
	});
	property(limits, "On limit", draft, "onLimit", {
		choices: [
			["", "Default"],
			["pause", "Pause"],
			["stop", "Stop"],
			["judge", "Ask a final model"],
		],
		after: useLimits,
	});
	property(limits, "Limit model", draft, "limitTarget", { choices: [["", "Default"], ...models], after: useLimits });
	inspector.append(limits);
	presets(inspector, mixture, "roles", "Local role presets");
	presets(inspector, mixture, "envelopes", "Local envelope presets");
	const gate = el("div");
	gate.className = "gate";
	gate.append(
		check("Steering · M3", !!mixture.steering, () => {}, true),
		check(
			"Fan-out and join · M4",
			mixture.edges.some(edge => Array.isArray(edge.to)),
			() => {},
			true,
		),
		check("Gateway serving · M6", mixture.serve === true, () => {}, true),
	);
	if (mixture.steering || mixture.serve)
		gate.append(
			button("Clear gated options", () => {
				delete mixture.steering;
				if (mixture.serve) delete mixture.serve;
				changed();
				renderInspector();
			}),
		);
	inspector.append(gate);
	inspector.append(
		button(
			"Delete mixture",
			() => {
				if (!window.confirm(`Delete ${mixture.name} from this draft?`)) return;
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
	group.append(el("legend", "State parts"));
	group.append(
		check("Choose state explicitly", target.state !== undefined, explicit => {
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
				["true", "Yes rubric"],
				["false", "No rubric"],
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
					score ? `Level ${key}` : key,
					value,
					text => {
						target.criteria[key] = score ? text : text.trim() ? text : null;
					},
					{ multiline: true },
				),
			);
			row.append(
				button(
					"Remove rubric",
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
			button(score ? "Add level" : "Add choice", () => {
				if (score) target.criteria.push("");
				else {
					const label = window.prompt("Choice label")?.trim();
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

function condition(member, key, title, note) {
	const panel = details(title, note);
	const render = () => {
		while (panel.children.length > 2) panel.lastElementChild.remove();
		const target = member[key];
		if (!target) {
			panel.append(
				button(`Add ${title.toLowerCase()}`, () => {
					member[key] = { instructions: "" };
					changed();
					render();
				}),
			);
			return;
		}
		property(panel, "Instructions", target, "instructions", { multiline: true, keepEmpty: true });
		stateParts(
			panel,
			target,
			transitParts.filter(([part]) => ["output", "input", "toolTrace"].includes(part)),
		);
		if (key === "route") {
			property(panel, "Minimum confidence", target, "minConfidence", { numeric: "decimal", min: 0, max: 1 });
			property(panel, "Fallback", target, "fallback", {
				choices: [
					["", "Default (pause)"],
					["pause", "Pause"],
					...mixture.edges.filter(edge => edge.from === member.id).map(edge => [edgeId(edge), edgeId(edge)]),
				],
			});
		} else {
			property(panel, "Yes threshold", target, "threshold", { numeric: "decimal", min: 0, max: 1 });
			rubrics(panel, target);
		}
		panel.append(
			button(
				"Remove condition",
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
	inspector.append(el("h2", member.kind === "verdict" ? "Verdict node" : "Model node"));
	inspector.append(
		field(
			"Member ID",
			member.id,
			(value, input) => {
				const id = value.trim();
				if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || mixture.members.some(item => item !== member && item.id === id)) {
					input.value = member.id;
					status("Enter a unique member ID using lowercase letters, digits, underscores or hyphens.", true);
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
	property(inspector, "Description", member, "description", { multiline: true });
	property(inspector, "Intermediate visibility", member, "show", { choices: modelShow });
	if (member.kind === "verdict") {
		property(inspector, "Question type", member.question, "type", {
			choices: [
				["noul", "Yes/no"],
				["choice", "Choice"],
				["score", "Score"],
			],
			after: () => {
				const type = member.question.type;
				if (type === "noul") delete member.question.criteria;
				else member.question.criteria = type === "score" ? ["", ""] : { first: null, second: null };
				renderInspector();
				renderGraph();
			},
		});
		property(inspector, "Question instructions", member.question, "instructions", {
			keepEmpty: true,
			multiline: true,
		});
		rubrics(inspector, member.question);
		stateParts(inspector, member, transitParts);
		property(inspector, "Render envelope", member, "render", { multiline: true, placeholder: "verdict" });
	} else {
		inspector.append(
			button(
				mixture.entry === member.id ? "Entry model" : "Set as entry",
				() => {
					mixture.entry = member.id;
					changed();
					redraw();
				},
				{ disabled: mixture.entry === member.id },
			),
		);
		property(inspector, "Model selector", member, "model", {
			keepEmpty: true,
			list: "models",
			placeholder: "provider/model or @role",
			after: renderGraph,
		});
		property(inspector, "Role preset", member, "role");
		inspector.append(
			check("Use inline system prompt (overrides role preset)", member.systemPrompt !== undefined, enabled => {
				if (enabled) member.systemPrompt = "";
				else delete member.systemPrompt;
				renderInspector();
			}),
		);
		if (member.systemPrompt !== undefined)
			property(inspector, "System prompt", member, "systemPrompt", { keepEmpty: true, multiline: true });
		inspector.append(
			field(
				"Inherit outer prompt",
				String(member.inherit ?? ""),
				value => {
					if (value === "") delete member.inherit;
					else member.inherit = value === "true";
				},
				{
					choices: [
						["", "Default"],
						["true", "Yes"],
						["false", "No"],
					],
				},
			),
		);
		property(inspector, "Maximum output tokens", member, "maxTokens", { numeric: "integer", min: 1 });
		condition(
			member,
			"route",
			"Routing",
			"The judge chooses only when multiple outgoing handoffs are eligible. A single eligible handoff is taken directly.",
		);
		condition(
			member,
			"terminate",
			"Termination",
			"Ask after this model's hop whether its output should finish the run.",
		);
		const gate = el("div");
		gate.className = "gate";
		gate.append(check("Caller tools · M3", member.tools !== false && member.tools !== undefined, () => {}, true));
		if (member.tools !== false)
			gate.append(
				button("Set tools explicitly off", () => {
					member.tools = false;
					changed();
					renderInspector();
				}),
			);
		inspector.append(gate);
	}
	inspector.append(
		button(
			"Delete member",
			() => {
				if (!window.confirm(`Delete ${member.id} and its attached handoffs from this draft?`)) return;
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
	inspector.append(el("h2", "Handoff"), el("p", `${edge.from} → ${[edge.to].flat().join(", ")}`));
	if (Array.isArray(edge.to)) {
		inspector.append(
			el("p", "Fan-out is not runnable until M4. Delete this handoff to replace it with sequential handoffs."),
		);
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
			field("Edge ID (optional)", edge.id, value => updateEdge("id", value.trim()), {
				commit: true,
				placeholder: edgeId(edge),
			}),
		);
		const edges = el("fieldset");
		edges.append(el("legend", "Transit parts (choose at least one)"));
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
		const transcript = details(
			"Transcript options",
			"These settings include the accumulated completed hop outputs in the handoff.",
		);
		for (const [title, key, options] of [
			[
				"Optimization",
				"optimize",
				{
					choices: [
						["", "Default"],
						["verbatim", "Verbatim"],
						["compact", "Compact"],
						["snapcompact", "Snapcompact"],
					],
				},
			],
			["Token budget", "budgetTokens", { numeric: "integer", min: 1 }],
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
		property(inspector, "When (routing rubric, not a filter)", edge, "when", { multiline: true, after: renderGraph });
		property(inspector, "Envelope preset or template", edge, "envelope", { multiline: true, placeholder: "handoff" });
		property(inspector, "Traversal cap", edge, "maxTraversals", { numeric: "integer", min: 0 });
		property(inspector, "Visibility override", edge, "show", { choices: modelShow.slice(0, 3) });
	}
	inspector.append(
		button(
			"Delete handoff",
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
		inspector.append(el("h2", "File presets"), el("p", "Shared by mixtures declared in this file."));
		presets(inspector, source.doc, "roles", "Role presets");
		presets(inspector, source.doc, "envelopes", "Envelope presets");
	} else if (!mixture) inspector.append(el("p", "Select a mixture to inspect its graph."));
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
