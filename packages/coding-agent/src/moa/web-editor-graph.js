"use strict";
/* Mixture Studio · graph: layout, wire routing, cards, camera. */

/* ═══════════════════════════ TIDY ═══════════════════════════
   Left to right from the start. Paths leave a card in the order its rows are listed, so wires rarely cross.
   Positions are view state: they are never written to MIXTURES.toml. */
const GAP_X = 84,
	GAP_Y = 44,
	PORT_Y = 25;
function tidy() {
	const state = new Map(),
		order = [],
		back = new Set(),
		found = new Map();
	const visit = id => {
		state.set(id, 1);
		found.set(id, found.size);
		for (const e of outs(id))
			for (const to of targets(e)) {
				if (!node(to)) continue;
				if (state.get(to) === 1) back.add(e.$k + ">" + to);
				else if (!state.has(to)) visit(to);
			}
		state.set(id, 2);
		order.unshift(id);
	};
	if (node(mix.entry)) visit(mix.entry);
	const depth = new Map(order.map(id => [id, 0]));
	for (const id of order)
		for (const e of outs(id))
			for (const to of targets(e))
				if (depth.has(to) && !back.has(e.$k + ">" + to) && to !== id)
					depth.set(to, Math.max(depth.get(to), depth.get(id) + 1));
	const layers = [];
	for (const id of order) (layers[depth.get(id)] ??= []).push(id);
	const top = new Map(),
		H = id => geo.get(id)?.h ?? 96;
	/* A column gap is as wide as the widest label that has to sit on a wire crossing it, so a label never ends up under a card. */
	const colX = [0];
	for (let col = 1; col < layers.length; col++) {
		let gap = GAP_X;
		for (const e of mix.edges) {
			if (isFan(e) || depth.get(e.from) !== col - 1 || depth.get(e.to) !== col) continue;
			const lab = edgeLabel(e);
			if (!lab.plain) gap = Math.max(gap, Math.ceil(lab.width) + 40);
		}
		colX[col] = colX[col - 1] + W + gap;
	}
	const portY = (id, key) => top.get(id) + (geo.get(id)?.rows[key] ?? PORT_Y);
	layers.forEach((ids, col) => {
		const want = ids
			.map(id => {
				const feeds = [];
				for (const e of ins(id))
					if (top.has(e.from) && !back.has(e.$k + ">" + id)) feeds.push(portY(e.from, e.$k) - PORT_Y);
				return { id, y: feeds.length ? feeds.reduce((a, b) => a + b, 0) / feeds.length : 0 };
			})
			.sort((a, b) => a.y - b.y || found.get(a.id) - found.get(b.id));
		let cursor = -Infinity,
			drift = 0;
		for (const w of want) {
			w.at = Math.max(w.y, cursor);
			cursor = w.at + H(w.id) + GAP_Y;
			drift += w.at - w.y;
		}
		drift /= want.length;
		for (const w of want) {
			top.set(w.id, w.at - drift);
			const n = node(w.id);
			n.$x = colX[col];
			n.$y = Math.round(w.at - drift);
		}
	});
	/* islands: members no path reaches. The on-limit model comes first. */
	const lt = limitTarget();
	const islands = mix.members.filter(n => !depth.has(n.id)).sort((a, b) => (b === lt) - (a === lt));
	let floor = Math.max(0, ...order.map(id => node(id).$y + H(id))) + (order.length ? 72 : 0),
		x = 0;
	for (const n of islands) {
		n.$x = x;
		n.$y = Math.round(floor);
		x += W + GAP_X;
	}
}

/* ═══════════════════════════ ROUTER ═══════════════════════════
   Orthogonal wires with rounded corners. Each wire tries a handful of shapes (straight ahead, a hook into the
   top or bottom of its target, a loop around) and keeps the one that is shortest, bends least, crosses least. */
const segs = points => points.slice(1).map((p, i) => [points[i], p]);
function hitsRect(a, b, r, pad) {
	const x1 = Math.min(a[0], b[0]),
		x2 = Math.max(a[0], b[0]),
		y1 = Math.min(a[1], b[1]),
		y2 = Math.max(a[1], b[1]);
	return x2 > r.x - pad && x1 < r.x + r.w + pad && y2 > r.y - pad && y1 < r.y + r.h + pad;
}
function crosses(a, b, c, d) {
	const av = a[0] === b[0],
		cv = c[0] === d[0];
	if (av === cv) {
		// parallel: only a problem if they lie on top of each other
		const k = av ? 0 : 1,
			o = 1 - k;
		if (Math.abs(a[k] - c[k]) > 5) return 0;
		const lo = Math.max(Math.min(a[o], b[o]), Math.min(c[o], d[o])),
			hi = Math.min(Math.max(a[o], b[o]), Math.max(c[o], d[o]));
		return hi - lo > 6 ? 4 : 0;
	}
	const [v1, v2, h1, h2] = av ? [a, b, c, d] : [c, d, a, b];
	const x = v1[0],
		y = h1[1];
	return x > Math.min(h1[0], h2[0]) + 1 &&
		x < Math.max(h1[0], h2[0]) - 1 &&
		y > Math.min(v1[1], v2[1]) + 1 &&
		y < Math.max(v1[1], v2[1]) - 1
		? 1
		: 0;
}
function candidates(S, py, T, self) {
	const out = [],
		xR = S.x + S.w,
		xL = S.x,
		ty = T.y + PORT_Y;
	if (!self && T.x - xR >= 36) {
		const mid = (xR + T.x) / 2;
		for (const j of [0, -1, 1, -2, 2]) {
			const mx = clamp(mid + j * 13, xR + 14, T.x - 14);
			out.push({
				side: "r",
				points:
					Math.abs(py - ty) < 1
						? [
								[xR, py],
								[T.x, ty],
							]
						: [
								[xR, py],
								[mx, py],
								[mx, ty],
								[T.x, ty],
							],
				bias: Math.abs(j) * 3,
			});
		}
	}
	for (const side of ["l", "r"]) {
		const dir = side === "r" ? 1 : -1,
			sx = side === "r" ? xR : xL;
		for (const entry of ["bottom", "top"]) {
			const ey = entry === "bottom" ? T.y + T.h : T.y,
				away = entry === "bottom" ? 1 : -1;
			for (const k of [0, 1, 2]) {
				const stub = sx + dir * (20 + k * 13);
				const ex = clamp(
					self ? (side === "r" ? T.x + T.w - 34 : T.x + 34) : stub,
					T.x + 30 + k * 14,
					T.x + T.w - 30 - k * 14,
				);
				/* hook: straight out, then one turn into the target */
				if (!self && k === 0) {
					const hx = clamp(side === "r" ? T.x + 34 : T.x + T.w - 34, T.x + 30, T.x + T.w - 30);
					if (dir * (hx - sx) >= 24 && away * (py - ey) >= 16)
						out.push({
							side,
							points: [
								[sx, py],
								[hx, py],
								[hx, ey],
							],
							entry,
							bias: side === "l" ? -6 : 0,
						});
				}
				/* loop: out, along a channel clear of everything between, and in */
				for (const reach of [24 + k * 13, null]) {
					let cy = ey + away * (reach ?? 0);
					if (reach === null) {
						const lo = Math.min(stub, ex) - 8,
							hi = Math.max(stub, ex) + 8;
						let far = entry === "bottom" ? -Infinity : Infinity;
						for (const r of geo.values())
							if (r.x < hi && r.x + r.w > lo)
								far = entry === "bottom" ? Math.max(far, r.y + r.h) : Math.min(far, r.y);
						cy = far + away * (26 + k * 13);
					}
					out.push({
						side,
						points: [
							[sx, py],
							[stub, py],
							[stub, cy],
							[ex, cy],
							[ex, ey],
						],
						entry,
						bias: 8 + k * 2,
					});
				}
			}
		}
	}
	return out;
}
function routeAll(obstacles) {
	const routed = [],
		result = new Map();
	const rank = e => {
		const a = geo.get(e.from),
			b = geo.get(e.to);
		return a && b && e.from !== e.to && b.x - (a.x + a.w) >= 36 ? 0 : 1;
	};
	const list = mix.edges.filter(e => !isFan(e) && geo.has(e.from) && geo.has(e.to)).sort((a, b) => rank(a) - rank(b));
	for (const e of list) {
		const S = geo.get(e.from),
			T = geo.get(e.to),
			py = S.y + (S.rows[e.$k] ?? PORT_Y),
			self = e.from === e.to;
		let best = null;
		for (const c of candidates(S, py, T, self)) {
			const parts = segs(c.points);
			let score = c.bias + parts.length * 34;
			for (const [a, b] of parts) {
				score += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
				for (const [id, r] of geo) {
					const mine = id === e.from || id === e.to;
					if (hitsRect(a, b, r, mine ? -2 : 9)) score += mine ? 2600 : 1800;
				}
				for (const r of obstacles) if (hitsRect(a, b, r, 4)) score += 420;
				for (const other of routed) for (const [c1, c2] of other) score += crosses(a, b, c1, c2) * 90;
			}
			if (!best || score < best.score) best = { ...c, score };
		}
		routed.push(segs(best.points));
		result.set(e.$k, best);
	}
	return result;
}
function roundPath(points, r = 11) {
	let d = "M" + points[0][0] + " " + points[0][1];
	for (let i = 1; i < points.length - 1; i++) {
		const [px, py] = points[i - 1],
			[x, y] = points[i],
			[nx, ny] = points[i + 1];
		const a = Math.min(r, Math.hypot(x - px, y - py) / 2),
			b = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
		const ux = Math.sign(x - px),
			uy = Math.sign(y - py),
			vx = Math.sign(nx - x),
			vy = Math.sign(ny - y);
		d += ` L${x - ux * a} ${y - uy * a} Q${x} ${y} ${x + vx * b} ${y + vy * b}`;
	}
	const end = points.at(-1);
	return d + ` L${end[0]} ${end[1]}`;
}
function arrowPath(points, size = 7) {
	const [x, y] = points.at(-1),
		[px, py] = points.at(-2),
		a = Math.atan2(y - py, x - px),
		s = 0.46;
	return `M${x} ${y} L${x - size * Math.cos(a - s)} ${y - size * Math.sin(a - s)} L${x - size * Math.cos(a + s)} ${y - size * Math.sin(a + s)}Z`;
}
/* Labels sit on the longest clear stretch of their wire: never on a card, a capsule or another label.
   When a wire is too short to hold its label, the label slides just clear of the card it would have covered. */
function labelSpot(points, width, taken, wires = []) {
	let best = null;
	const over = (box, r, px, py) =>
		box.x < r.x + r.w + px && box.x + box.w > r.x - px && box.y < r.y + r.h + py && box.y + box.h > r.y - py;
	const tryBox = (x, y, base) => {
		const box = { x: x - width / 2, y: y - 10, w: width, h: 20 };
		let score = base;
		for (const r of geo.values()) if (over(box, r, 6, 4)) score -= 400;
		for (const r of taken) if (over(box, r, 4, 3)) score -= 300;
		for (const [c, d] of wires) if (hitsRect(c, d, box, 2)) score -= 22;
		if (!best || score > best.score) best = { score, x, y, box };
	};
	for (const [a, b] of segs(points)) {
		const flat = a[1] === b[1],
			len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
		for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
			const x = a[0] + (b[0] - a[0]) * t,
				y = a[1] + (b[1] - a[1]) * t,
				base = (flat ? Math.min(len, width + 40) : Math.min(len, 60) * 0.5) - Math.abs(t - 0.5) * 30;
			tryBox(x, y, base);
			if (t !== 0.5) continue;
			for (const r of geo.values()) {
				if (!over({ x: x - width / 2, y: y - 10, w: width, h: 20 }, r, 6, 4)) continue;
				const lo = Math.min(a[flat ? 0 : 1], b[flat ? 0 : 1]) - 16,
					hi = Math.max(a[flat ? 0 : 1], b[flat ? 0 : 1]) + 16; // stay on this wire, never drift off it
				const alts = flat ? [r.x - 14 - width / 2, r.x + r.w + 14 + width / 2] : [r.y - 18, r.y + r.h + 18];
				for (const v of alts)
					if (flat ? v + width / 2 >= lo && v - width / 2 <= hi : v >= lo && v <= hi)
						flat ? tryBox(v, y, base - 24) : tryBox(x, v, base - 24);
			}
		}
	}
	taken.push(best.box);
	return best;
}

/* ═══════════════════════════ GRAPH ═══════════════════════════ */
const world = $("world"),
	canvas = $("canvas");
let wireGeo = new Map(),
	pillGeo = [];
const kindIcon = n => (isModel(n) ? "spark" : "scale");
const verdictWord = n =>
	({
		noul: T("verdict.kind.noul"),
		choice: T("verdict.kind.choice", { n: choicesOf(n).length }),
		score: T("verdict.kind.score", { n: Math.max(0, (n.question.criteria?.length ?? 1) - 1) }),
	})[n.question?.type] ?? "?";
function verdictChips(n) {
	if (n.question?.type === "choice") return choicesOf(n).map(c => h("span", {}, c[0] || "·"));
	if (n.question?.type === "score") return (n.question.criteria ?? []).map((_, i) => h("span", { class: "lvl" }, i));
	return [h("span", {}, T("verdict.yes")), h("span", {}, T("verdict.no"))];
}
function capBadge(e) {
	if (cap(e) === undefined) return null;
	const used = trial?.used[e.$k] ?? 0;
	return h(
		"span",
		{ class: cls("cap", trial && used && "used"), title: T("card.cap.title", { n: cap(e) }) },
		trial ? `${used}/${cap(e)}` : `≤${cap(e)}×`,
	);
}
function rowEl(n, r) {
	const e = r.edge,
		picked = e && selIs("edge", e.$k),
		spent = trial && e && cap(e) !== undefined && (trial.used[e.$k] ?? 0) >= cap(e);
	const base = {
		class: cls(
			"orow",
			r.t,
			r.last && "last",
			picked && "sel",
			spent && "spent",
			e && trial?.choices.includes(e.$k) && "choice",
		),
		"data-row": r.key,
		"data-edge": e?.$k,
	};
	const port = h("i", { class: "port", "data-port": r.key });
	if (r.t === "head")
		return h(
			"div",
			{ class: "ohead", title: T("card.judge.title", { id: n.id }) },
			icon("diamond", 11),
			T("card.judge"),
			h("small", {}, n.route?.fallback && n.route.fallback !== "pause" ? null : T("card.judge.pauses")),
		);
	if (r.t === "stop")
		return h(
			"div",
			{ ...base, title: T("card.stop.title") },
			h("span", { class: "og" }, icon("diamondo", 13)),
			h(
				"span",
				{ class: "ot" },
				h(
					"span",
					{ class: "cond" },
					r.text?.trim()
						? TX("card.stop", { text: r.text })
						: TX("card.stop.none", { none: h("span", { class: "none" }, T("card.stop.blank")) }),
				),
			),
			port,
		);
	if (r.t === "final")
		return h(
			"div",
			{ ...base, class: base.class + " derived" },
			h("span", { class: "og" }, icon("dot", 12)),
			h("span", { class: "ot" }, r.text),
			port,
		);
	if (r.t === "ends")
		return h(
			"div",
			{ ...base, class: base.class + " derived", title: T("card.ends.title") },
			h("span", { class: "og" }, icon("dot", 12)),
			h("span", { class: "ot" }, r.text),
			port,
		);
	if (r.t === "locked")
		return h(
			"div",
			{ ...base, title: T("card.fanout.title") },
			h("span", { class: "og" }, icon("lock", 13)),
			h(
				"span",
				{ class: "ot" },
				TX("card.fanout", { ids: e.to.map((id, i) => [i > 0 && " + ", h("b", { class: "idn" }, id)]) }),
			),
			h("span", { class: "ms" }, "M4"),
			port,
		);
	const fallback =
		n.route?.fallback === eid(e) && h("span", { class: "fb", title: T("card.unsure.title") }, T("card.unsure"));
	if (r.t === "branch")
		return h(
			"div",
			base,
			h(
				"span",
				{ class: "ot" },
				h("span", { class: "cond" }, e.when?.trim() || h("span", { class: "none" }, T("card.when.none"))),
				h("span", { class: "dest" }, "→ " + e.to, capBadge(e), fallback),
			),
			port,
		);
	return h(
		"div",
		{ ...base, title: e.when ? T("card.only.title") : null },
		h("span", { class: "og" }, icon("right", 13)),
		h(
			"span",
			{ class: "ot" },
			h("span", { class: "cond" }, n.terminate ? TX("card.else", { id: e.to }) : TX("card.then", { id: e.to })),
			e.when && h("span", { class: "dest" }, h("s", {}, e.when)),
		),
		capBadge(e),
		port,
	);
}
function cardEl(n) {
	const rows = rowsOf(n),
		simple = isSimple(n, rows),
		list = issuesFor("node", n.id),
		sev = worst(list),
		model = isModel(n);
	const res = model ? resolveModel(n) : null;
	const el = h(
		"div",
		{
			class: cls(
				"node",
				model ? "model" : "verdict",
				n.id === mix.entry && "start",
				selIs("node", n.id) && "sel",
				multi.has(n.id) && "multi",
				trial?.at === n.id && "here",
			),
			"data-id": n.id,
			tabIndex: 0,
			role: "button",
			style: { width: W + "px" },
			"aria-label":
				(model ? T("card.aria.model", { id: n.id }) : T("card.aria.verdict", { id: n.id })) +
				(n.id === mix.entry ? ", " + T("card.aria.start") : ""),
		},
		h(
			"div",
			{ class: "nhead" },
			h(
				"div",
				{ class: "nrow1" },
				h("span", { class: "kind" }, icon(kindIcon(n), 13)),
				h("span", { class: "nid", title: T("card.rename.title") }, n.id),
				h(
					"span",
					{ class: "badges" },
					toolsOn(n) && h("span", { class: "badge lock", title: T("card.tools.title") }, icon("lock", 10), "M3"),
					(n.show === "final" || n.show === "never") &&
						h("span", { class: "hid", title: T("card.hidden.title") }, icon("eyeoff", 13)),
					sev &&
						h("span", { class: "flag " + sev, title: list.map(i => i.msg).join("\n") }, sev === "e" ? "!" : "~"),
				),
			),
			model
				? h(
						"div",
						{ class: "nmeta" },
						h(
							"span",
							{ title: res.state === "ok" ? T("card.resolves.title", { model: res.res }) : null },
							n.model || T("card.model.none"),
						),
						res.effort && [h("span", { class: "dot" }, "·"), h("span", {}, res.effort)],
						n.systemPrompt === undefined &&
							n.role && [
								h("span", { class: "dot" }, "·"),
								h("span", { class: "role" }, T("card.role", { name: n.role })),
							],
					)
				: h(
						"div",
						{ class: "nmeta" },
						h("span", {}, T("card.verdict")),
						h("span", { class: "dot" }, "·"),
						h("span", { class: "role" }, verdictWord(n)),
					),
			(model ? n.description : n.question?.instructions) &&
				h("div", { class: "ndesc" }, model ? n.description : n.question.instructions),
			!model && h("div", { class: "vchips" }, verdictChips(n)),
			simple && h("i", { class: "port", "data-port": rows[0].key, style: { top: PORT_Y + "px" } }),
		),
		!simple &&
			h(
				"div",
				{ class: "nouts" },
				rows.map(r => rowEl(n, r)),
			),
		model &&
			h(
				"button",
				{
					class: "grow",
					tabIndex: -1,
					"data-grow": n.id,
					title: T("card.grow.title"),
					"aria-label": T("card.grow.aria", { id: n.id }),
				},
				icon("plus", 15),
			),
	);
	el._simple = simple;
	el._rows = rows;
	return el;
}
function measure() {
	geo.clear();
	for (const el of $("nodes").children) {
		const n = node(el.dataset.id),
			rows = {};
		if (el._simple) rows[el._rows[0].key] = PORT_Y;
		else
			for (const row of el.querySelectorAll("[data-row]"))
				rows[row.dataset.row] = row.offsetTop + row.offsetHeight / 2;
		geo.set(n.id, {
			x: n.$x ?? 0,
			y: n.$y ?? 0,
			w: W,
			h: el.offsetHeight,
			rows,
			ends: el._rows.filter(r => r.t === "final" || r.t === "stop" || r.t === "ends"),
		});
	}
}
function wireEl(key, kind, points, { arrow = true, edgeId, title } = {}) {
	const g = svgEl("g", { class: "w " + kind, "data-wire": key, "data-edge": edgeId });
	const d = roundPath(points);
	g.append(svgEl("path", { class: "halo", d }), svgEl("path", { class: "line", d }));
	if (arrow) g.append(svgEl("path", { class: "head", d: arrowPath(points) }));
	if (edgeId) g.append(svgEl("path", { class: "hit", d }));
	if (title) {
		const t = svgEl("title");
		t.textContent = title;
		g.append(t);
	}
	return g;
}
const envWord = e => envName(e) ?? T("path.envelope.custom");
/* One sentence that says everything about a path. Used for hover titles, so a wire can be read without selecting it. */
function edgeSentence(e) {
	const toVerdict = !isModel(node(e.to)),
		parts = partsText(e);
	const when = isBranch(e)
		? e.when?.trim()
			? T("wire.when.judgeWhen", { from: e.from, when: e.when })
			: T("wire.when.judge", { from: e.from })
		: T("wire.when.always", { from: e.from });
	const what = toVerdict
		? T("wire.what.verdict", { to: e.to, parts })
		: T("wire.what.model", { to: e.to, parts, envelope: envWord(e) });
	return [when, what, cap(e) !== undefined && T("wire.cap", { n: cap(e) })].filter(Boolean).join(" ");
}
function edgeLabel(e) {
	const toVerdict = !isModel(node(e.to)),
		env = envWord(e),
		parts = partsOf(e);
	const plain = parts.length === 1 && parts[0] === "output" && (toVerdict || envName(e) === "handoff") && !e.id;
	const words = partsText(e) + (toVerdict ? "" : " in " + env);
	return {
		plain,
		width: ((e.id?.length ?? 0) + words.length) * 6.4 + 44,
		nodes: [
			icon(toVerdict ? "scale" : "mail", 11),
			h("span", {}, partsText(e)),
			!toVerdict && [h("b", {}, T("wire.in")), h("span", {}, env)],
		],
	};
}
/* place(): position cards, then draw everything that depends on where they are. Cheap enough to run on every drag frame. */
function place() {
	for (const el of $("nodes").children) {
		const g = geo.get(el.dataset.id),
			n = node(el.dataset.id);
		g.x = n.$x;
		g.y = n.$y;
		el.style.transform = `translate(${n.$x}px,${n.$y}px)`;
	}
	const svg = $("wires"),
		labels = $("labels"),
		pills = $("pills");
	svg.replaceChildren();
	labels.replaceChildren();
	pills.replaceChildren();
	pillGeo = [];
	const entry = node(mix.entry),
		lt = limitTarget();
	const pill = (type, x, y, w, text, attrs) => {
		pillGeo.push({ x, y: y - 12, w, h: 24 });
		const el = h(
			"button",
			{ class: "pill " + type, tabIndex: -1, style: { left: x + "px", top: y - 12 + "px" }, ...attrs },
			text,
		);
		pills.append(el);
		return el;
	};
	/* where a run enters */
	if (isModel(entry) && geo.has(entry.id)) {
		const g = geo.get(entry.id),
			y = g.y + PORT_Y;
		pill("prompt", g.x - 104, y, 76, T("pill.prompt"), { "data-pill": "prompt", title: T("pill.prompt.title") });
		svg.append(
			wireEl("io-prompt", "io", [
				[g.x - 28, y],
				[g.x - 1, y],
			]),
		);
	}
	/* where a limit sends it */
	if (lt && geo.has(lt.id)) {
		const g = geo.get(lt.id),
			y = g.y + PORT_Y + (lt === entry ? 30 : 0);
		pill("limit", g.x - 112, y, 84, T("pill.limit"), {
			"data-pill": "limit",
			title: T("pill.limit.title", { id: lt.id }),
		});
		svg.append(
			wireEl("io-limit", "limit", [
				[g.x - 28, y],
				[g.x - 1, y],
			]),
		);
	}
	/* where it can end */
	for (const [id, g] of geo) {
		if (!g.ends.length) continue;
		const first = g.y + g.rows[g.ends[0].key],
			px = g.x + g.w + 28,
			sure = g.ends.some(r => r.t === "final");
		pill(cls("answer", !sure && (g.ends[0].t === "stop" ? "maybe" : "ghost")), px, first, 72, T("pill.answer"), {
			"data-pill": "answer",
			"data-id": id,
			title: sure ? T("pill.answer.sure", { id }) : T("pill.answer.maybe", { id }),
		});
		g.ends.forEach((r, i) => {
			const y = g.y + g.rows[r.key],
				x = g.x + g.w;
			const kind =
				"io" +
				(r.t === "stop" ? " maybe" : r.t === "ends" ? " ghost" : "") +
				(trial?.endRow === id + "/" + r.key ? " walked" : "");
			svg.append(
				wireEl(
					"io-" + id + "-" + r.key,
					kind,
					i === 0
						? [
								[x, y],
								[px - 1, y],
							]
						: [
								[x, y],
								[x + 22, y],
								[x + 22, first],
							],
					{ arrow: i === 0 },
				),
			);
		});
	}
	/* handoffs */
	wireGeo = routeAll(pillGeo);
	const takenLabels = pillGeo.map(p => ({ ...p }));
	const focusNode = sel?.kind === "node" ? sel.id : null;
	for (const e of mix.edges) {
		const r = wireGeo.get(e.$k);
		if (!r) continue;
		const picked = selIs("edge", e.$k),
			branch = isBranch(e),
			hot = hoverEdge === e.$k;
		const related = focusNode ? e.from === focusNode || e.to === focusNode : true;
		const spent = trial && cap(e) !== undefined && (trial.used[e.$k] ?? 0) >= cap(e);
		svg.append(
			wireEl(
				e.$k,
				cls(
					branch && "cond",
					picked && "sel",
					hot && "hot",
					(!related || (sel?.kind === "edge" && !picked)) && "dim",
					trial?.walked.has(e.$k) && "walked",
					spent && "spent",
				),
				r.points,
				{ edgeId: e.$k, title: edgeSentence(e) },
			),
		);
		$("nodes")
			.querySelector(`[data-id="${CSS.escape(e.from)}"] [data-port="${e.$k}"]`)
			?.classList.toggle("left", r.side === "l");
		const found = issuesFor("edge", e.$k),
			sev = worst(found);
		const others = [];
		for (const [k, o] of wireGeo) if (k !== e.$k) others.push(...segs(o.points));
		const lab = edgeLabel(e),
			terse = lab.plain && sev && !picked && !hot; // a default handoff with a problem shows just its flag
		const width = terse ? 30 : lab.width + (sev ? 20 : 0);
		const spot =
			lab.plain && !picked && !sev
				? labelSpot(r.points, width, [], others)
				: labelSpot(r.points, width, takenLabels, others);
		labels.append(
			h(
				"button",
				{
					class: cls(
						"wlabel",
						picked && "sel",
						lab.plain && !sev && "quiet",
						(picked || hot) && "show",
						!related && "dim",
					),
					tabIndex: -1,
					"data-edge": e.$k,
					style: { left: spot.x + "px", top: spot.y + "px" },
					title: sev ? found.map(i => i.msg).join("\n") : edgeSentence(e),
				},
				sev && h("span", { class: "flag " + sev }, sev === "e" ? "!" : "~"),
				e.id && h("span", { class: "eid" }, e.id),
				!terse && lab.nodes,
			),
		);
	}
	/* locked fan-out: drawn so the import is legible, dotted because this build will not run it */
	for (const e of mix.edges) {
		if (!isFan(e) || !geo.has(e.from)) continue;
		const S = geo.get(e.from),
			py = S.y + (S.rows[e.$k] ?? PORT_Y);
		for (const to of e.to) {
			const T2 = geo.get(to);
			if (!T2) continue;
			const mx = (S.x + S.w + T2.x) / 2,
				ty = T2.y + PORT_Y;
			svg.append(
				wireEl(
					e.$k + ">" + to,
					cls("locked", selIs("edge", e.$k) && "sel"),
					Math.abs(py - ty) < 1
						? [
								[S.x + S.w, py],
								[T2.x, ty],
							]
						: [
								[S.x + S.w, py],
								[mx, py],
								[mx, ty],
								[T2.x, ty],
							],
					{ edgeId: e.$k },
				),
			);
		}
	}
	if (connect?.preview) svg.append(wireEl("preview", "preview", connect.preview, { arrow: true }));
}
function renderGraph() {
	const host = $("nodes"),
		had = document.activeElement?.closest?.(".node")?.dataset.id;
	canvas.classList.toggle("ro", !!mix && readOnly());
	canvas.toggleAttribute("data-trial", !!trial);
	if (!mix) {
		host.replaceChildren();
		$("wires").replaceChildren();
		$("labels").replaceChildren();
		$("pills").replaceChildren();
		geo.clear();
		wireGeo = new Map();
		pillGeo = [];
		renderEmpty();
		return;
	}
	host.replaceChildren(...mix.members.map(cardEl));
	measure();
	if (mix.members.some(n => n.$x == null)) tidy();
	place();
	if (had) host.querySelector(`[data-id="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
	renderEmpty();
}

/* ── camera ── */
let camTouched = false;
function applyCam() {
	world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`;
	const s = 24 * cam.z * (cam.z < 0.55 ? 2 : 1);
	canvas.style.setProperty("--gs", s + "px");
	canvas.style.setProperty("--gx", (cam.x % s) + "px");
	canvas.style.setProperty("--gy", (cam.y % s) + "px");
	const out = $("zoom").querySelector("output");
	if (out) out.textContent = Math.round(cam.z * 100) + "%";
}
/* How much of the canvas the surrounding chrome covers. In a narrow window the inspector sits under the canvas, not beside it. */
/* The inspector sits beside the canvas while there is room for both next to a pinned list; otherwise under it.
   This is decided from the room that is actually left, not from the window width alone. */
const STACK_BELOW = 860;
function layout() {
	if (sidePinned && !canPin()) sidePinned = false;
	const sl = sideOpen && sidePinned ? side.offsetWidth : 0;
	document.body.classList.toggle("stacked", innerWidth - sl < STACK_BELOW);
	document.body.style.setProperty("--sl", sl + "px");
}
const stacked = () => document.body.classList.contains("stacked");
/* sl: the pinned list. l r t b: everything that covers the canvas on each side (list, inspector, toolbars). */
function insets() {
	const panel = $("panel"),
		below = stacked(),
		open = panelOpen && !!mix,
		sl = sideOpen && sidePinned ? side.offsetWidth : 0;
	return {
		sl,
		l: sl + (below ? 46 : 0),
		r: open && !below ? panel.offsetWidth + 24 : 0,
		t: below ? 70 : 64,
		b:
			open && below
				? panel.offsetHeight + 20
				: trial
					? ($("trial").offsetHeight || 250) + (below ? 24 : 90)
					: below
						? 64
						: 98,
	};
}
const viewCenter = () => {
	const i = insets();
	return [i.l + (canvas.clientWidth - i.l - i.r) / 2, i.t + (canvas.clientHeight - i.t - i.b) / 2];
};
function bounds() {
	const boxes = [...geo.values(), ...pillGeo];
	for (const r of wireGeo.values()) for (const [x, y] of r.points) boxes.push({ x, y, w: 0, h: 0 });
	if (!boxes.length) return null;
	const x1 = Math.min(...boxes.map(b => b.x)),
		y1 = Math.min(...boxes.map(b => b.y)),
		x2 = Math.max(...boxes.map(b => b.x + b.w)),
		y2 = Math.max(...boxes.map(b => b.y + b.h));
	return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function fit(animate) {
	const b = bounds();
	if (!b) return;
	const i = insets(),
		vw = canvas.clientWidth - i.l - i.r,
		vh = canvas.clientHeight - i.t - i.b,
		padX = 22;
	cam.z = clamp(Math.min((vw - padX * 2) / b.w, vh / b.h), 0.12, 1.35);
	cam.x = i.l + (vw - b.w * cam.z) / 2 - b.x * cam.z;
	cam.y = i.t + (vh - b.h * cam.z) / 2 - b.y * cam.z;
	camTouched = false;
	glide(animate);
}
function glide(animate) {
	if (animate) {
		world.style.transition = "transform .35s cubic-bezier(.2,.8,.2,1)";
		setTimeout(() => {
			world.style.transition = "";
		}, 380);
	}
	applyCam();
}
function zoomAt(z, cx, cy) {
	if (cx === undefined) [cx, cy] = viewCenter();
	z = clamp(z, 0.25, 2.2);
	camTouched = true;
	cam.x = cx - ((cx - cam.x) * z) / cam.z;
	cam.y = cy - ((cy - cam.y) * z) / cam.z;
	cam.z = z;
	applyCam();
}
function reveal(id) {
	const g = geo.get(id);
	if (!g) return;
	const i = insets(),
		sx = g.x * cam.z + cam.x,
		sy = g.y * cam.z + cam.y,
		w = g.w * cam.z,
		hh = g.h * cam.z;
	if (
		sx > i.l + 20 &&
		sy > i.t - 10 &&
		sx + w < canvas.clientWidth - i.r - 20 &&
		sy + hh < canvas.clientHeight - i.b + 10
	)
		return;
	const [cx, cy] = viewCenter();
	cam.x = cx - (g.x + g.w / 2) * cam.z;
	cam.y = cy - (g.y + g.h / 2) * cam.z;
	glide(true);
}
const toWorld = (cx, cy) => {
	const r = canvas.getBoundingClientRect();
	return [(cx - r.left - cam.x) / cam.z, (cy - r.top - cam.y) / cam.z];
};
function flash(id) {
	const el = $("nodes").querySelector(`[data-id="${CSS.escape(id)}"]`);
	if (!el) return;
	el.classList.remove("pulse");
	void el.offsetWidth;
	el.classList.add("pulse");
}

/* ── selection ── */
function select(next, { keepTab, section } = {}) {
	sel = next;
	multi.clear();
	focusSection = section ?? null;
	if (!keepTab && tab !== "toml") tab = "inspect";
	const opened = !!next && !panelOpen;
	if (opened) panelOpen = true;
	render();
	if (opened && !camTouched) fit(true); // the inspector takes room: keep the whole graph in view
	if (next?.kind === "node") reveal(next.id);
}
