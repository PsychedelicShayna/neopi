"use strict";
/* Mixture Studio · canvas: menus and sheets, connecting, deleting, pointer and keyboard. */

/* ═══════════════════════════ FLOATING LAYER ═══════════════════════════ */
const layer = $("layer");
let popEl = null,
	popOwner = null,
	sheetEl = null;
function closePop() {
	popEl?.remove();
	popEl = null;
	popOwner?.setAttribute?.("aria-expanded", "false");
	popOwner = null;
}
function openPop(anchor, content, { align = "left", width, at, cls: extra } = {}) {
	closePop();
	const pop = h(
		"div",
		{
			class: cls("pop", extra),
			role: "menu",
			style: width ? { width: Math.min(width, innerWidth - 16) + "px" } : null,
		},
		content,
	);
	layer.append(pop);
	let x, y;
	if (at) [x, y] = at;
	else {
		const r = anchor.getBoundingClientRect();
		x =
			align === "right"
				? r.right - pop.offsetWidth
				: align === "center"
					? r.left + r.width / 2 - pop.offsetWidth / 2
					: r.left;
		y = r.bottom + 6;
		if (y + pop.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - 6 - pop.offsetHeight);
	}
	pop.style.left = clamp(x, 8, Math.max(8, innerWidth - pop.offsetWidth - 8)) + "px";
	pop.style.top = clamp(y, 8, Math.max(8, innerHeight - pop.offsetHeight - 8)) + "px";
	pop.style.maxHeight = innerHeight - 16 + "px";
	popEl = pop;
	popOwner = anchor ?? null;
	anchor?.setAttribute?.("aria-expanded", "true");
	return pop;
}
const togglePop = (anchor, build, opts) => {
	if (popOwner === anchor) {
		closePop();
		return null;
	}
	return openPop(anchor, build(), opts);
};
document.addEventListener(
	"pointerdown",
	ev => {
		if (popEl && !popEl.contains(ev.target) && !popOwner?.contains?.(ev.target)) closePop();
	},
	true,
);
function mi(ic, label, run, { hint, danger, disabled, mono, on, title } = {}) {
	return h(
		"button",
		{
			class: cls("mi", danger && "danger", mono && "mono", on && "on"),
			type: "button",
			disabled,
			title,
			role: "menuitem",
			onclick: () => {
				closePop();
				run();
			},
		},
		ic && icon(ic),
		h("span", {}, label),
		hint && h("small", {}, hint),
	);
}
function closeSheet() {
	const back = sheetEl?._back;
	sheetEl?.remove();
	sheetEl = null;
	if (back?.isConnected && !back.disabled) back.focus({ preventScroll: true });
}
/* Every dialog is built here, so the buttons are always in the same place: a note on the left, then any
   secondary actions, then Cancel, then the one primary action at the far right. Destructive primaries are red. */
function openSheet({ title, sub, body, note, cancel = T("common.cancel"), primary, extra = [], wide, width, onClose }) {
	const before = sheetEl?._back;
	if (sheetEl) {
		sheetEl._back = null;
	}
	closeSheet();
	closePop();
	const close = () => {
		closeSheet();
		onClose?.();
	};
	const go =
		primary &&
		h(
			"button",
			{
				class: cls("btn primary", primary.danger && "danger"),
				type: "button",
				disabled: primary.disabled,
				title: primary.title,
				onclick: primary.run,
			},
			primary.label,
		);
	const sheet = h(
		"div",
		{
			class: cls("sheet", !wide && "narrow"),
			tabIndex: -1,
			role: "dialog",
			"aria-modal": "true",
			"aria-label": typeof title === "string" ? title : null,
			style: width ? { width: `min(${width}px,calc(100vw - 16px))` } : null,
		},
		h(
			"header",
			{},
			h("div", { style: { minWidth: 0 } }, h("h2", {}, title), sub && h("p", {}, sub)),
			h("span", { class: "sp" }),
			h(
				"button",
				{
					class: "icon-btn",
					type: "button",
					"aria-label": T("common.close"),
					title: T("common.close.title"),
					onclick: close,
				},
				icon("x"),
			),
		),
		h("div", { class: "body" }, body),
		h(
			"footer",
			{},
			h("span", { class: "note" }, note),
			h("span", { class: "sp" }),
			extra,
			cancel && h("button", { class: "btn", type: "button", onclick: close }, cancel),
			go,
		),
	);
	/* A dialog owns the keyboard while it is open: focus starts inside it, Tab stays inside it, and closing it
     puts focus back where it was. */
	const back = before ?? document.activeElement;
	sheetEl = h(
		"div",
		{
			class: "scrim",
			onpointerdown: ev => {
				if (ev.target === sheetEl) close();
			},
		},
		sheet,
	);
	sheetEl._close = close;
	sheetEl._back = back;
	sheetEl.addEventListener("keydown", ev => {
		if (ev.key !== "Tab") return;
		const stops = [...sheet.querySelectorAll('button,input,textarea,select,[tabindex]:not([tabindex="-1"])')].filter(
			el => !el.disabled && el.offsetParent !== null,
		);
		if (!stops.length) {
			ev.preventDefault();
			return sheet.focus();
		}
		const first = stops[0],
			last = stops.at(-1),
			at = document.activeElement;
		if (!sheet.contains(at) || at === sheet) {
			ev.preventDefault();
			(ev.shiftKey ? last : first).focus();
		} else if (ev.shiftKey && at === first) {
			ev.preventDefault();
			last.focus();
		} else if (!ev.shiftKey && at === last) {
			ev.preventDefault();
			first.focus();
		}
	});
	layer.append(sheetEl);
	const start = sheet.querySelector("[data-autofocus]") ?? (go && !go.disabled ? go : null);
	(start ?? sheet).focus({ preventScroll: true });
	return sheet;
}
function toast(text, { undo: withUndo, bad } = {}) {
	const box = $("toasts");
	while (box.children.length > 1) box.firstChild.remove();
	const el = h(
		"div",
		{ class: "toast", role: "status" },
		icon(bad ? "warn" : "check"),
		h("span", {}, text),
		withUndo &&
			h(
				"button",
				{
					type: "button",
					onclick: () => {
						el.remove();
						undo();
					},
				},
				T("common.undo"),
			),
	);
	if (bad) el.querySelector("svg").style.color = "var(--warn)";
	box.append(el);
	setTimeout(() => el.remove(), bad ? 5200 : 3400);
}
/* Copy without depending on the clipboard permission: the old way still works where the new one is refused. */
function copyText(value, done) {
	const old = () => {
		const ta = h("textarea", { value, style: { position: "fixed", opacity: "0" } });
		document.body.append(ta);
		ta.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {}
		ta.remove();
		return ok;
	};
	const say = ok => toast(ok ? done : T("toml.copyFailed"), { bad: !ok });
	if (navigator.clipboard?.writeText)
		navigator.clipboard.writeText(value).then(
			() => say(true),
			() => say(old()),
		);
	else say(old());
}
function coach(content, bad) {
	const el = $("coach");
	el.hidden = !content;
	el.classList.toggle("no", !!bad);
	if (content) el.replaceChildren(...[content].flat(Infinity).filter(Boolean));
}
/* Editing is refused, with the reason, while the file is read-only or a trial run is walking the graph. */
function guard() {
	if (!mix) return false;
	if (trial) {
		toast(T("guard.trial"), { bad: true });
		return false;
	}
	if (readOnly()) {
		toast(T("guard.readOnly"), { bad: true });
		return false;
	}
	return true;
}

/* ═══════════════════════════ CONNECTING ═══════════════════════════
   One state machine for every way of wiring: drag from +, drag a port to retarget, drag the Prompt plug,
   or click-click from the dock. A card always says whether it can receive, and why not. */
function refusal(targetId) {
	const t = node(targetId);
	if (connect.entry) return isModel(t) ? null : T("connect.no.entryVerdict");
	if (connect.from == null) return isModel(t) ? null : T("connect.no.fromVerdict");
	if (!connect.edgeKey && mix.edges.length >= boot.limits.edges)
		return T("connect.no.full", { max: boot.limits.edges });
	return null;
}
function startConnect(opts) {
	closePop();
	if (!guard()) return false;
	connect = { from: null, via: "click", preview: null, ...opts };
	canvas.dataset.connect = "";
	markTargets();
	coachConnect();
	renderDock();
	return true;
}
function markTargets() {
	for (const el of $("nodes").children) {
		const no = connect && refusal(el.dataset.id);
		el.classList.toggle("accept", !!connect && !no && el.dataset.id === connect.over);
		el.classList.toggle("deny", !!no);
	}
}
function coachConnect(why) {
	if (!connect) return coach(null);
	if (why) return coach([icon("warn"), why], true);
	const esc = h("kbd", {}, "Esc");
	if (connect.entry) return coach([T("connect.coach.entry"), esc]);
	if (connect.from == null) return coach([T("connect.coach.source"), esc]);
	if (connect.edgeKey) return coach([T("connect.coach.retarget"), esc]);
	const over = connect.over && node(connect.over),
		from = connect.from;
	const text = over
		? over.id === from
			? T("connect.coach.self", { from })
			: isModel(over)
				? `${from} → ${over.id}`
				: T("connect.coach.verdict", { from, to: over.id })
		: connect.via === "drag"
			? T("connect.coach.drag", { from })
			: T("connect.coach.click", { from });
	coach([text, esc]);
}
function endConnect() {
	if (!connect) return;
	connect = null;
	delete canvas.dataset.connect;
	for (const el of $("nodes").children) el.classList.remove("accept", "deny");
	coach(null);
	if (mix) place();
	renderDock();
}
function sourcePoint() {
	if (connect.entry) {
		const g = geo.get(mix.entry);
		return [g.x - 28, g.y + PORT_Y];
	}
	const g = geo.get(connect.from);
	if (!g) return null;
	return [g.x + g.w, g.y + (connect.edgeKey ? (g.rows[connect.edgeKey] ?? PORT_Y) : PORT_Y)];
}
function previewTo(wx, wy) {
	if (!connect || (!connect.entry && connect.from == null)) {
		if (connect) connect.preview = null;
		return;
	}
	const [sx, sy] = sourcePoint();
	const T2 = connect.over && !refusal(connect.over) && geo.get(connect.over);
	if (connect.entry) {
		connect.preview = T2
			? [
					[T2.x - 104, T2.y + PORT_Y],
					[T2.x - 1, T2.y + PORT_Y],
				]
			: [
					[wx - 60, wy],
					[wx, wy],
				];
		return;
	}
	if (T2 && connect.over === connect.from) {
		const y = T2.y - 26;
		connect.preview = [
			[sx, sy],
			[sx + 26, sy],
			[sx + 26, y],
			[T2.x + T2.w - 40, y],
			[T2.x + T2.w - 40, T2.y],
		];
		return;
	}
	const [ex, ey] = T2 ? [T2.x, T2.y + PORT_Y] : [wx, wy];
	if (ex - sx >= 28) {
		const mx = (sx + ex) / 2;
		connect.preview =
			Math.abs(sy - ey) < 1
				? [
						[sx, sy],
						[ex, ey],
					]
				: [
						[sx, sy],
						[mx, sy],
						[mx, ey],
						[ex, ey],
					];
	} else
		connect.preview = T2
			? [
					[sx, sy],
					[sx + 26, sy],
					[sx + 26, T2.y + T2.h + 26],
					[T2.x + 40, T2.y + T2.h + 26],
					[T2.x + 40, T2.y + T2.h],
				]
			: [
					[sx, sy],
					[sx + 26, sy],
					[sx + 26, ey],
					[ex, ey],
				];
}
function finishConnect(targetId) {
	const no = refusal(targetId);
	if (no) {
		coachConnect(no);
		flash(targetId);
		return;
	}
	const c = connect;
	if (c.entry) {
		endConnect();
		if (targetId !== mix.entry)
			commit(T("act.start", { id: targetId }), () => {
				mix.entry = targetId;
			});
		return;
	}
	if (c.from == null) {
		connect.from = targetId;
		connect.over = null;
		markTargets();
		coachConnect();
		renderDock();
		return;
	}
	endConnect();
	if (c.edgeKey) {
		const e = edge(c.edgeKey);
		if (e && e.to !== targetId)
			commit(T("act.retarget", { id: targetId }), () =>
				keepingFallbacks(() => {
					e.to = targetId;
				}),
			);
		return;
	}
	connectNodes(c.from, targetId);
}
function connectNodes(from, to) {
	let made;
	commit(
		T("act.connect"),
		() => {
			made = addEdge(from, to);
			sel = { kind: "edge", id: made.e.$k };
			multi.clear();
			tab = "inspect";
			panelOpen = true;
			focusSection = made.count >= 2 ? "when" : null;
		},
		{ quiet: true },
	);
	toast(
		made.count === 1
			? T("connect.done.only", { from, to })
			: made.routed
				? T("connect.done.routed", { from })
				: T("connect.done.more", { n: made.count, from }),
		{ undo: true },
	);
	return made.e;
}
function freeSpot(x, y) {
	let tries = 0;
	while (
		tries++ < 40 &&
		[...geo.values()].some(r => x < r.x + r.w + 24 && x + W + 24 > r.x && y < r.y + r.h + 24 && y + 110 > r.y)
	)
		y += 36;
	return [Math.round(x / 4) * 4, Math.round(y / 4) * 4];
}
function createAt(kind, wx, wy, { from, rename = true } = {}) {
	if (!guard()) return null;
	if (mix.members.length >= boot.limits.members) {
		toast(T("create.full", { max: boot.limits.members }), { bad: true });
		return null;
	}
	let n, made;
	commit(
		kind === "verdict" ? T("act.addVerdict") : T("act.addModel"),
		() => {
			const [x, y] = freeSpot(wx, wy);
			n = addNode(kind, x, y);
			if (from) made = addEdge(from, n.id);
			sel = { kind: "node", id: n.id };
			multi.clear();
			tab = "inspect";
			panelOpen = true;
		},
		{ quiet: true },
	);
	if (made?.routed) toast(T("create.routed", { from }), { undo: true });
	else if (n.id === mix.entry && mix.members.filter(isModel).length === 1) toast(T("create.first", { id: n.id }));
	if (rename) renameInline(n.id);
	return n;
}
function addMenu(at, wx, wy, from) {
	openPop(
		null,
		[
			h("h4", {}, from ? T("add.menu.from", { from }) : T("add.menu")),
			mi("spark", T("add.model"), () => createAt("model", wx, wy, { from }), { hint: "M" }),
			mi("scale", T("add.verdict"), () => createAt("verdict", wx, wy, { from }), { hint: "V" }),
		],
		{ at },
	);
}
function idProblem(value, current, list = mix.members.map(n => n.id)) {
	if (!value) return T("id.empty");
	if (!ID_RE.test(value)) return T("id.invalid");
	if (value !== current && list.includes(value)) return T("id.taken", { id: value });
	return null;
}
/* Typing help for IDs and names: lower case, spaces to dashes, everything else that cannot be stored is dropped. */
const tidyId = (text, dots) =>
	text
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(dots ? /[^a-z0-9._-]/g : /[^a-z0-9_-]/g, "");
function liveTidy(input, dots) {
	input.addEventListener("input", () => {
		const at = input.selectionStart,
			v = tidyId(input.value, dots);
		if (v !== input.value) {
			input.value = v;
			input.setSelectionRange(at, at);
		}
	});
	return input;
}
function renamed(refs, id) {
	toast(refs ? TN("rename.done.refs", refs, { id }) : T("rename.done", { id }), { undo: true });
}
function renameInline(id) {
	const label = $("nodes").querySelector(`[data-id="${CSS.escape(id)}"] .nid`);
	if (!label || !guard()) return;
	const input = liveTidy(
		h("input", {
			class: "nid-edit",
			value: id,
			spellcheck: "false",
			autocomplete: "off",
			"aria-label": T("rename.aria", { id }),
		}),
	);
	label.replaceWith(input);
	input.focus();
	input.select();
	let done = false;
	const finish = keep => {
		if (done) return;
		done = true;
		const value = input.value.trim(),
			why = keep && value !== id && idProblem(value, id);
		if (!keep || value === id || why) {
			if (why) toast(why, { bad: true });
			render();
			return;
		}
		const n = node(id);
		let refs;
		commit(
			T("act.rename"),
			() => {
				refs = renameNode(n, value);
			},
			{ quiet: true },
		);
		renamed(refs, value);
	};
	input.addEventListener("input", () => input.classList.toggle("bad", !!idProblem(input.value, id)));
	input.addEventListener("keydown", ev => {
		if (!(ev.ctrlKey || ev.metaKey)) ev.stopPropagation();
		if (ev.key === "Enter") finish(true);
		if (ev.key === "Escape") finish(false);
	});
	input.addEventListener("blur", () => finish(true));
	input.addEventListener("change", () => finish(true));
}

/* ═══════════════════════════ DELETING ═══════════════════════════
   Removing a member is a graph transaction: its impact is spelled out before anything changes. */
function impactOf(n) {
	const lines = [],
		touching = mix.edges.filter(e => e.from === n.id || targets(e).includes(n.id));
	if (touching.length) {
		const list = touching.map(e => e.id ?? `${e.from} → ${targets(e).join(" + ")}`).join(", ");
		lines.push([
			"link",
			touching.length === 1 ? TX("impact.path", { list }) : TX("impact.paths", { n: touching.length, list }),
		]);
	}
	if (mix.entry === n.id) {
		const next = mix.members.find(x => isModel(x) && x !== n);
		lines.push(["flag", next ? TX("impact.entry", { id: next.id }) : T("impact.entry.none")]);
	}
	if (limitTarget() === n) lines.push(["hour", TX("impact.limit")]);
	for (const src of new Set(ins(n.id).map(e => e.from))) {
		if (src === n.id) continue;
		const left = liveOuts(src).filter(e => e.to !== n.id).length,
			s = node(src),
			fb = s.route?.fallback;
		if (left === 0)
			lines.push(["dot", s.route ? TX("impact.final.route", { id: src }) : TX("impact.final", { id: src })]);
		else if (left === 1 && s.route) lines.push(["right", TX("impact.bypass", { id: src })]);
		if (fb && mix.edges.find(e => e.from === src && eid(e) === fb)?.to === n.id)
			lines.push(["pause", TX("impact.fallback", { id: src })]);
	}
	return lines;
}
function deleteNodes(ids) {
	const nodes = ids.map(node).filter(Boolean);
	if (!nodes.length || !guard()) return;
	const lines = nodes.flatMap(n => impactOf(n).map(l => [n, ...l]));
	const go = () => {
		closeSheet();
		commit(
			nodes.length === 1 ? T("act.deleted", { id: nodes[0].id }) : T("act.deletedMany", { n: nodes.length }),
			() => {
				for (const n of nodes) {
					const sources2 = new Set(ins(n.id).map(e => e.from));
					if (limitTarget() === n) setLimit("onLimit", D().onLimit === "judge" ? "pause" : undefined);
					removeNode(n);
					for (const id of sources2) {
						const s = node(id);
						if (s?.route && !liveOuts(id).length && !outs(id).length) delete s.route;
					}
				}
			},
		);
	};
	if (!lines.length) return go();
	openSheet({
		title: nodes.length === 1 ? T("delete.title", { id: nodes[0].id }) : T("delete.titleMany", { n: nodes.length }),
		sub: T("delete.sub"),
		body: h(
			"ul",
			{ class: "impact" },
			lines.map(([n, ic, text]) =>
				h("li", {}, icon(ic), h("span", {}, nodes.length > 1 && [h("b", {}, n.id), ": "], text)),
			),
		),
		note: T("delete.note"),
		primary: { label: T("common.delete"), danger: true, run: go },
	});
}
function deleteEdge(e) {
	if (!guard()) return;
	const source = node(e.from),
		left = liveOuts(e.from).filter(x => x !== e).length,
		from = e.from;
	commit(
		T("act.removePath"),
		() => {
			removeEdge(e);
			if (source?.route && !outs(from).length) delete source.route;
		},
		{ quiet: true },
	);
	toast(
		isFan(e)
			? T("edge.removed")
			: left === 0
				? T("edge.removed.final", { from })
				: left === 1
					? T("edge.removed.one", { from })
					: T("edge.removed"),
		{ undo: true },
	);
}
function insertOn(e) {
	if (!guard()) return;
	if (mix.members.length >= boot.limits.members)
		return toast(T("create.full", { max: boot.limits.members }), { bad: true });
	const a = geo.get(e.from),
		b = geo.get(e.to);
	let n;
	commit(
		T("act.insert"),
		() => {
			const [x, y] = freeSpot((a.x + b.x) / 2, (a.y + b.y) / 2 + (Math.abs(a.x - b.x) < W + 60 ? 150 : 0));
			n = addNode("model", x, y);
			const after = { from: n.id, to: e.to, x: { output: true }, $k: "k" + ++edgeSeq };
			keepingFallbacks(() => {
				e.to = n.id;
			});
			mix.edges.push(after);
			sel = { kind: "node", id: n.id };
		},
		{ quiet: true },
	);
	toast(T("edge.inserted", { id: n.id }), { undo: true });
	renameInline(n.id);
}
function reverseEdge(e) {
	if (!guard()) return;
	if (!isModel(node(e.to))) return toast(T("edge.reverse.no"), { bad: true });
	commit(T("act.reverse"), () => {
		keepingFallbacks(() => {
			[e.from, e.to] = [e.to, e.from];
		});
		const now = node(e.from);
		if (liveOuts(e.from).length >= 2 && !now.route?.instructions)
			now.route = { ...now.route, instructions: starterRoute(e.from) };
	});
}
function duplicateNode(n) {
	if (!guard()) return;
	if (mix.members.length >= boot.limits.members)
		return toast(T("create.full", { max: boot.limits.members }), { bad: true });
	let copy;
	commit(T("act.duplicated", { id: n.id }), () => {
		copy = clone(n);
		copy.id = freeId(n.id.replace(/-\d+$/, "") + "-", new Set(mix.members.map(x => x.id)));
		delete copy.route;
		[copy.$x, copy.$y] = freeSpot(n.$x + 40, n.$y + (geo.get(n.id)?.h ?? 100) + 40);
		mix.members.push(copy);
		sel = { kind: "node", id: copy.id };
	});
}

/* ═══════════════════════════ POINTER ═══════════════════════════ */
let lastClick = { t: 0, what: null },
	guide = null,
	spaceDown = false;
/* Hold Space to pan with the left button, as in most canvas tools. Middle-drag pans too. */
addEventListener("keydown", ev => {
	if (ev.code === "Space" && !ev.repeat && (ev.target === document.body || ev.target === canvas)) {
		spaceDown = true;
		canvas.dataset.space = "";
		ev.preventDefault();
	}
});
addEventListener("keyup", ev => {
	if (ev.code === "Space") {
		spaceDown = false;
		delete canvas.dataset.space;
	}
});
addEventListener("blur", () => {
	spaceDown = false;
	delete canvas.dataset.space;
});
const chrome = ".hud,.dock,.trial,.coach,.reopen,.empty>div,.banner";
function hoverEdgeSet(key) {
	if (hoverEdge === key) return;
	for (const el of world.querySelectorAll(".hot,.wlabel.show:not(.sel)")) el.classList.remove("hot", "show");
	hoverEdge = key;
	if (key)
		for (const el of world.querySelectorAll(`[data-edge="${key}"]`)) {
			if (el.classList.contains("w") || el.classList.contains("orow")) el.classList.add("hot");
			if (el.classList.contains("wlabel")) el.classList.add("show");
		}
}
canvas.addEventListener("pointerover", ev => {
	if (!gesture) hoverEdgeSet(ev.target.closest?.("[data-edge]")?.dataset.edge ?? null);
});
canvas.addEventListener("pointerdown", ev => {
	const t = ev.target;
	if (!mix || t.closest(chrome) || t.closest(".nid-edit") || ev.button === 2) return;
	document.activeElement?.blur?.();
	closeSide();
	const nodeEl = t.closest(".node"),
		id = nodeEl?.dataset.id,
		at = [ev.clientX, ev.clientY];
	const begin = g => {
		gesture = { pointer: ev.pointerId, at, moved: false, ...g };
		try {
			canvas.setPointerCapture(ev.pointerId);
		} catch {}
		ev.preventDefault();
	};
	if (ev.button === 1) return begin({ type: "pan", cx: cam.x, cy: cam.y, middle: true });
	if (connect?.via === "click") {
		if (id) finishConnect(id);
		else endConnect();
		return ev.preventDefault();
	}
	const editable = !readOnly() && !trial;
	const grow = t.closest("[data-grow]");
	if (grow && editable) {
		startConnect({ from: grow.dataset.grow, via: "drag" });
		return begin({ type: "connect", origin: "grow" });
	}
	const port = t.closest(".port")?.dataset.port;
	if (port && editable && edge(port) && !isFan(edge(port))) {
		startConnect({ from: id, edgeKey: port, via: "drag" });
		return begin({ type: "connect", origin: "port" });
	}
	const pill = t.closest(".pill");
	if (pill) return begin({ type: "pill", pill: pill.dataset.pill, id: pill.dataset.id });
	if (nodeEl) {
		const group = multi.has(id) ? [...multi] : [id];
		return begin({
			type: "node",
			id,
			row: t.closest(".orow,.ohead")?.dataset.row ?? (t.closest(".ohead") ? ":head" : undefined),
			rowEdge: t.closest(".orow")?.dataset.edge,
			shift: ev.shiftKey,
			start: group.map(g => ({ n: node(g), x: node(g).$x, y: node(g).$y })),
		});
	}
	const wire = t.closest(".wlabel,.w")?.dataset.edge;
	if (wire) return begin({ type: "wire", id: wire });
	begin(spaceDown || trial ? { type: "pan", cx: cam.x, cy: cam.y } : { type: "marquee", add: ev.shiftKey });
});
canvas.addEventListener("pointermove", ev => {
	if (!mix) return;
	const [wx, wy] = toWorld(ev.clientX, ev.clientY);
	if (connect && (!gesture || gesture.type === "connect")) {
		const over =
			document.elementsFromPoint(ev.clientX, ev.clientY).find(el => el.classList?.contains("node"))?.dataset.id ??
			null;
		if (over !== connect.over) {
			connect.over = over;
			markTargets();
			coachConnect(over && refusal(over));
		}
		if (gesture) gesture.moved ||= Math.hypot(ev.clientX - gesture.at[0], ev.clientY - gesture.at[1]) > 5;
		previewTo(wx, wy);
		place();
		return;
	}
	const g = gesture;
	if (!g || g.pointer !== ev.pointerId) return;
	const dx = ev.clientX - g.at[0],
		dy = ev.clientY - g.at[1];
	if (!g.moved && Math.hypot(dx, dy) < 4) return;
	const first = !g.moved;
	g.moved = true;
	if (g.type === "pan") {
		if (first) canvas.dataset.pan = "";
		cam.x = g.cx + dx;
		cam.y = g.cy + dy;
		camTouched = true;
		applyCam();
	} else if (g.type === "pill" && g.pill === "prompt" && !readOnly() && !trial) {
		if (startConnect({ entry: true, via: "drag" })) {
			g.type = "connect";
			g.origin = "pill";
		}
	} else if (g.type === "node" && !trial) {
		if (first)
			$("nodes")
				.querySelector(`[data-id="${CSS.escape(g.id)}"]`)
				?.classList.add("dragging");
		let mx = dx / cam.z,
			my = dy / cam.z;
		if (g.start.length === 1 && !ev.altKey) {
			// snap a lone card to its neighbours' edges and to the wire that feeds it
			const nx = g.start[0].x + mx,
				ny = g.start[0].y + my;
			let gx = null,
				gy = null;
			for (const [oid, o] of geo) {
				if (oid === g.id) continue;
				if (gx == null && Math.abs(o.x - nx) < 7) gx = o.x;
				for (const y of [o.y, ...Object.values(o.rows).map(r => o.y + r - PORT_Y)])
					if (gy == null && Math.abs(y - ny) < 7) gy = y;
			}
			if (gx != null) mx = gx - g.start[0].x;
			if (gy != null) my = gy - g.start[0].y;
			showGuide(gx, gy);
		}
		for (const s of g.start) {
			s.n.$x = Math.round(s.x + mx);
			s.n.$y = Math.round(s.y + my);
		}
		place();
	} else if (g.type === "marquee") {
		const r = canvas.getBoundingClientRect(),
			m = $("marquee");
		m.hidden = false;
		Object.assign(m.style, {
			left: Math.min(g.at[0], ev.clientX) - r.left + "px",
			top: Math.min(g.at[1], ev.clientY) - r.top + "px",
			width: Math.abs(dx) + "px",
			height: Math.abs(dy) + "px",
		});
	}
});
function showGuide(gx, gy) {
	guide?.remove();
	guide = null;
	if (gx == null && gy == null) return;
	guide = h(
		"div",
		{ class: "guides" },
		gx != null && h("i", { style: { left: gx + "px", top: "-4000px", width: "1px", height: "8000px" } }),
		gy != null && h("i", { style: { top: gy + PORT_Y + "px", left: "-4000px", height: "1px", width: "8000px" } }),
	);
	world.append(guide);
}
function endGesture(ev) {
	const g = gesture;
	if (!g || g.pointer !== ev.pointerId) return;
	gesture = null;
	delete canvas.dataset.pan;
	$("marquee").hidden = true;
	showGuide(null, null);
	const cancelled = ev.type !== "pointerup",
		[wx, wy] = toWorld(ev.clientX, ev.clientY);
	const now = performance.now(),
		twice = what => {
			const hit = lastClick.what === what && now - lastClick.t < 400;
			lastClick = { t: hit ? 0 : now, what };
			return hit;
		};
	if (g.type === "connect") {
		if (cancelled || !connect) return endConnect();
		const over = document.elementsFromPoint(ev.clientX, ev.clientY).find(el => el.classList?.contains("node"))
			?.dataset.id;
		if (!g.moved && g.origin === "grow") {
			connect.via = "click";
			connect.over = null;
			markTargets();
			coachConnect();
			return;
		} // a click on + arms click-to-connect
		if (!g.moved) return endConnect();
		if (over) return finishConnect(over);
		const from = connect.from,
			canCreate = g.origin === "grow";
		endConnect();
		if (canCreate) addMenu([ev.clientX - 12, ev.clientY - 12], wx - 10, wy - PORT_Y, from);
		return;
	}
	if (cancelled) return;
	if (g.type === "node") {
		if (g.moved) {
			render();
			return;
		} // positions are view state: moving a card is not an edit
		if (trial) {
			if (g.rowEdge && trial.choices.includes(g.rowEdge)) trialTake(edge(g.rowEdge));
			return;
		}
		if (g.shift) {
			if (sel?.kind === "node" && !multi.size) multi.add(sel.id);
			multi.has(g.id) ? multi.delete(g.id) : multi.add(g.id);
			sel = null;
			render();
			return;
		}
		if (twice("node:" + g.id) && !g.rowEdge) {
			select({ kind: "node", id: g.id });
			return renameInline(g.id);
		}
		if (g.rowEdge) return select({ kind: "edge", id: g.rowEdge });
		return select(
			{ kind: "node", id: g.id },
			{ section: g.row === ":stop" ? "stop" : g.row === ":head" ? "paths" : null },
		);
	}
	if (g.type === "wire") return trial ? null : select({ kind: "edge", id: g.id });
	if (g.type === "pill") {
		if (trial) return;
		if (g.pill === "limit") return select(null, { section: "limits" });
		return select({ kind: "node", id: g.pill === "prompt" ? mix.entry : g.id });
	}
	if (g.type === "marquee") {
		if (!g.moved) {
			// a plain click on empty canvas
			if (twice("bg") && !readOnly()) return addMenu([ev.clientX - 12, ev.clientY - 12], wx - W / 2, wy - PORT_Y);
			if (sel || multi.size) select(null);
			return;
		}
		const a = toWorld(...g.at),
			x1 = Math.min(a[0], wx),
			x2 = Math.max(a[0], wx),
			y1 = Math.min(a[1], wy),
			y2 = Math.max(a[1], wy);
		if (!g.add) multi.clear();
		else if (sel?.kind === "node") multi.add(sel.id);
		for (const [id, r] of geo) if (r.x < x2 && r.x + r.w > x1 && r.y < y2 && r.y + r.h > y1) multi.add(id);
		sel = multi.size === 1 ? { kind: "node", id: [...multi][0] } : null;
		if (sel) multi.clear();
		render();
		return;
	}
	if (g.type === "pan" && !g.moved && !g.middle && !trial && (sel || multi.size)) select(null);
}
for (const name of ["pointerup", "pointercancel"]) canvas.addEventListener(name, endGesture);
canvas.addEventListener(
	"wheel",
	ev => {
		if (!mix || ev.target.closest(".trial,.pop,.empty>div")) return;
		ev.preventDefault();
		const r = canvas.getBoundingClientRect();
		const wheel = ev.ctrlKey || ev.deltaMode === 1 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 80);
		if (wheel)
			zoomAt(
				cam.z * Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : ev.ctrlKey ? 0.01 : 0.0016)),
				ev.clientX - r.left,
				ev.clientY - r.top,
			);
		else {
			cam.x -= ev.deltaX;
			cam.y -= ev.deltaY;
			camTouched = true;
			applyCam();
		}
	},
	{ passive: false },
);
canvas.addEventListener("contextmenu", ev => {
	if (!mix || ev.target.closest(chrome)) return;
	ev.preventDefault();
	if (trial) return;
	const id = ev.target.closest(".node")?.dataset.id,
		key = ev.target.closest("[data-edge]")?.dataset.edge,
		at = [ev.clientX, ev.clientY],
		[wx, wy] = toWorld(...at);
	if (key && edge(key)) {
		select({ kind: "edge", id: key });
		return openPop(null, edgeMenu(edge(key)), { at });
	}
	if (id) {
		select({ kind: "node", id });
		return openPop(null, nodeMenu(node(id)), { at });
	}
	const ro = readOnly();
	openPop(
		null,
		[
			h("h4", {}, T("menu.canvas")),
			mi("spark", T("menu.addModel"), () => createAt("model", wx - W / 2, wy - PORT_Y), { hint: "M", disabled: ro }),
			mi("scale", T("menu.addVerdict"), () => createAt("verdict", wx - W / 2, wy - PORT_Y), {
				hint: "V",
				disabled: ro,
			}),
			h("hr"),
			mi("tidy", T("menu.tidy"), tidyUp, { hint: "T" }),
			mi("fit", T("menu.fit"), () => fit(true), { hint: "F" }),
		],
		{ at },
	);
});
function nodeMenu(n) {
	const model = isModel(n),
		ro = readOnly(),
		lt = limitTarget() === n;
	return [
		h("h4", {}, n.id),
		mi("edit", T("menu.rename"), () => renameInline(n.id), { hint: "Enter", disabled: ro }),
		model && mi("link", T("menu.addPath"), () => startConnect({ from: n.id }), { hint: "C", disabled: ro }),
		model && n.id !== mix.entry && mi("flag", T("menu.startHere"), () => setEntry(n), { disabled: ro }),
		model && mi("hour", lt ? T("menu.limitOff") : T("menu.limitOn"), () => toggleLimitTarget(n), { disabled: ro }),
		model && mi("dup", T("common.duplicate"), () => duplicateNode(n), { hint: "Ctrl D", disabled: ro }),
		h("hr"),
		mi("trash", T("common.delete"), () => deleteNodes([n.id]), { danger: true, hint: "Del", disabled: ro }),
	];
}
function edgeMenu(e) {
	const ro = readOnly(),
		fan = isFan(e);
	return [
		h("h4", {}, `${e.from} → ${targets(e).join(" + ")}`),
		!fan && mi("spark", T("menu.insert"), () => insertOn(e), { disabled: ro }),
		!fan && mi("swap", T("menu.reverse"), () => reverseEdge(e), { disabled: ro || !isModel(node(e.to)) }),
		fan &&
			mi("diamond", T("menu.convert"), () => guard() && commit(T("act.convert"), () => convertFanout(e)), {
				disabled: ro,
			}),
		h("hr"),
		mi("trash", T("menu.removePath"), () => deleteEdge(e), { danger: true, hint: "Del", disabled: ro }),
	];
}
function setEntry(n) {
	if (guard())
		commit(T("act.start", { id: n.id }), () => {
			mix.entry = n.id;
		});
}
function toggleLimitTarget(n) {
	if (!guard()) return;
	const on = limitTarget() === n;
	commit(on ? T("act.limitPause") : T("act.limitAnswer", { id: n.id }), () => {
		if (on) {
			setLimit("limitTarget", undefined);
			setLimit("onLimit", D().onLimit === "judge" ? "pause" : undefined);
		} else {
			setLimit("onLimit", "judge");
			setLimit("limitTarget", n.id);
		}
	});
}
function tidyUp() {
	if (!mix) return;
	for (const n of mix.members) n.$x = null;
	render();
	fit(true);
	toast(T("tidy.done"));
}

/* ═══════════════════════════ KEYBOARD ═══════════════════════════
   Single letters only act while no field has focus. No function keys anywhere; Esc backs out one step at a time. */
function stepSelection(dx, dy) {
	const ids = [...geo.keys()];
	if (!ids.length) return;
	const from = sel?.kind === "node" ? sel.id : sel?.kind === "edge" ? edge(sel.id)?.from : null;
	if (!from || !geo.has(from)) return select({ kind: "node", id: node(mix.entry) ? mix.entry : ids[0] });
	const a = geo.get(from),
		ax = a.x + a.w / 2,
		ay = a.y + a.h / 2;
	let best = null;
	for (const id of ids) {
		if (id === from) continue;
		const b = geo.get(id),
			bx = b.x + b.w / 2 - ax,
			by = b.y + b.h / 2 - ay,
			along = bx * dx + by * dy,
			across = Math.abs(bx * dy) + Math.abs(by * dx);
		if (along <= 10) continue;
		const cost = along + across * 2.2;
		if (!best || cost < best.cost) best = { id, cost };
	}
	if (best) select({ kind: "node", id: best.id });
}
function centerSpot() {
	const anchor = sel?.kind === "node" && geo.get(sel.id);
	if (anchor) return [anchor.x + W + GAP_X, anchor.y];
	const r = canvas.getBoundingClientRect(),
		[cx, cy] = viewCenter();
	return toWorld(r.left + cx - (W * cam.z) / 2, r.top + cy - 60);
}
/* Ctrl S while a name or ID is still being typed: what is in the field is kept first, exactly as leaving the field
   would, so the save includes it. If the field refuses it, the reason is shown and nothing is saved yet. */
function settleField() {
	const a = document.activeElement;
	if (!a || !/^(INPUT|TEXTAREA)$/.test(a.tagName) || a.closest(".sheet,.pop")) return true;
	if (a.classList.contains("rn")) {
		a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		return !sideRename;
	}
	const typed = a.value;
	a.dispatchEvent(new Event("change", { bubbles: true }));
	if (a.isConnected) a.blur();
	return !(a.isConnected && a.value !== typed);
}
document.addEventListener("keydown", ev => {
	const typingNow = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName),
		mod = ev.ctrlKey || ev.metaKey,
		key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
	if (mod && key === "s") {
		ev.preventDefault();
		return settleField() && openSave();
	}
	/* Ctrl C cancels, as it does everywhere in NeoPi, unless there is text selected to copy. */
	if (mod && key === "c" && !ev.shiftKey && !ev.altKey) {
		const picked =
			String(getSelection() ?? "") !== "" || (typingNow && ev.target.selectionStart !== ev.target.selectionEnd);
		if (picked) return;
		if (popEl) {
			ev.preventDefault();
			return closePop();
		}
		if (sheetEl) {
			ev.preventDefault();
			return sheetEl._close();
		}
		if (connect) {
			ev.preventDefault();
			return endConnect();
		}
		if (sideRename) {
			ev.preventDefault();
			sideRename = null;
			return renderSide();
		}
		return;
	}
	if (ev.key === "Escape") {
		if (popEl) return closePop();
		if (sheetEl) return sheetEl._close();
		if (typingNow) return ev.target.blur();
		if (connect) return endConnect();
		if (sideOpen && !sidePinned) return closeSide(true);
		if (trial) return trialEnd();
		if (mix && (sel || multi.size)) return select(null);
		return;
	}
	if (typingNow || sheetEl) return;
	if (mod && key === "z") {
		ev.preventDefault();
		return ev.shiftKey ? redo() : undo();
	}
	if (mod && key === "y") {
		ev.preventDefault();
		return redo();
	}
	if (mod || ev.altKey) return;
	if (key === "b") {
		ev.preventDefault();
		return toggleSide();
	}
	if (key === "?") {
		ev.preventDefault();
		return openKeys();
	}
	if (!mix || ev.target.closest?.(".side")) return;
	const focused = document.activeElement?.closest?.(".node")?.dataset.id;
	if ((ev.key === "Enter" || ev.key === " ") && focused) {
		ev.preventDefault();
		if (connect) return finishConnect(focused);
		if (selIs("node", focused) && ev.key === "Enter") return renameInline(focused);
		return select({ kind: "node", id: focused });
	}
	if (ev.target.closest?.("button,a,[role=tab]")) return;
	const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
	if (arrows) {
		ev.preventDefault();
		if (sel?.kind === "edge" && arrows[1] && edge(sel.id)) {
			const sibs = outs(edge(sel.id).from),
				i = sibs.findIndex(e => e.$k === sel.id),
				next = sibs[i + arrows[1]];
			if (next) select({ kind: "edge", id: next.$k });
			return;
		}
		stepSelection(...arrows);
		if (sel?.kind === "node")
			$("nodes")
				.querySelector(`[data-id="${CSS.escape(sel.id)}"]`)
				?.focus({ preventScroll: true });
		return;
	}
	if (ev.key === "Enter" && sel?.kind === "node") {
		ev.preventDefault();
		return connect ? finishConnect(sel.id) : renameInline(sel.id);
	}
	if (ev.key === "Delete" || ev.key === "Backspace") {
		ev.preventDefault();
		if (multi.size) return deleteNodes([...multi]);
		if (sel?.kind === "node") return deleteNodes([sel.id]);
		if (sel?.kind === "edge" && edge(sel.id)) return deleteEdge(edge(sel.id));
		return;
	}
	const run = {
		m: () => createAt("model", ...centerSpot()),
		v: () => createAt("verdict", ...centerSpot()),
		c: () =>
			connect ? endConnect() : startConnect({ from: sel?.kind === "node" && isModel(node(sel.id)) ? sel.id : null }),
		d: () => sel?.kind === "node" && duplicateNode(node(sel.id)),
		t: tidyUp,
		f: () => fit(true),
		0: () => zoomAt(1),
		"=": () => zoomAt(cam.z * 1.2),
		"+": () => zoomAt(cam.z * 1.2),
		"-": () => zoomAt(cam.z / 1.2),
		"/": openFind,
		r: () => (trial ? trialEnd() : trialStart()),
		i: () => {
			panelOpen = !panelOpen;
			render();
			if (!camTouched) fit(true);
		},
	}[key];
	if (run) {
		ev.preventDefault();
		run();
	}
});
document.addEventListener("keydown", ev => {
	// Ctrl D and Ctrl A are separate so the plain letters above stay simple
	if (!(ev.ctrlKey || ev.metaKey) || !mix || sheetEl || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
	const key = ev.key.toLowerCase();
	if (key === "d" && sel?.kind === "node") {
		ev.preventDefault();
		duplicateNode(node(sel.id));
	}
	if (key === "a") {
		ev.preventDefault();
		multi.clear();
		for (const n of mix.members) multi.add(n.id);
		sel = null;
		render();
	}
});
