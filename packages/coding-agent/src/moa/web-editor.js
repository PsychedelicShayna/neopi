"use strict";
/* Mixture Studio · app: the server API, top bar, dock, trial run, help, startup. */

/* ═══════════════════════════ SERVER ═══════════════════════════
   The page lives under a one-time capability URL that NeoPi made for the session that ran /moa web.
   It only ever sends source IDs, never paths, and every route is relative to that URL. */
let offline = 0;
const api = (() => {
	async function call(method, route, body) {
		try {
			const res = await fetch(route, {
				method,
				cache: "no-store",
				headers: body ? { "Content-Type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined,
			});
			let data = null;
			try {
				data = await res.json();
			} catch {
				/* an empty or non-JSON body is reported by status alone */
			}
			if (offline) {
				offline = 0;
				renderBanner();
			}
			if (res.status === 410) gone(data?.error);
			return { ok: res.ok, status: res.status, data };
		} catch {
			offline++;
			renderBanner();
			return { ok: false, status: 0, data: { error: T("api.offline") } };
		}
	}
	return {
		bootstrap: () => call("GET", "bootstrap"),
		sources: () => call("GET", "mixtures/sources"),
		source: id => call("GET", "mixtures/source?id=" + encodeURIComponent(id)),
		draft: (sourceId, draftDoc) => call("POST", "mixtures/draft", { sourceId, doc: draftDoc }),
		save: list => call("PUT", "mixtures/save", { files: list }),
	};
})();
/* The session that opened this page moved on (new session, another folder, or /moa web was run again). */
function gone(why) {
	if (document.querySelector(".dead")) return;
	clearInterval(watching);
	const unsaved = dirty();
	document.body.append(
		h(
			"div",
			{ class: "dead", role: "alertdialog" },
			h(
				"div",
				{},
				h("h2", {}, T("gone.title")),
				h("p", {}, why ?? T("gone.why")),
				h("p", {}, TX("gone.how")),
				unsaved && h("p", {}, T("gone.unsaved")),
				unsaved &&
					h(
						"button",
						{ class: "btn", type: "button", onclick: ev => ev.currentTarget.closest(".dead").remove() },
						T("gone.look"),
					),
			),
		),
	);
}

/* ═══════════════════════════ TOP BAR ═══════════════════════════ */
const short = hash => (hash ? "@" + String(hash).slice(0, 7) : "");
const diskRow = () => mix?.$o && srcOf(mix.$o.sid)?.mixtures.find(x => x.name === mix.$o.name);
function rosterWord() {
	const row = diskRow();
	if (!row) return [T("bar.roster.new"), ""];
	return (
		{
			registered: [T("bar.roster.registered"), "good"],
			shadowed: [T("bar.roster.shadowed"), "lag"],
			invalid: [T("bar.roster.invalid"), "lag"],
			unregistered: [T("bar.roster.unregistered"), "lag"],
		}[row.status] ?? [T("bar.roster.unknown"), ""]
	);
}
function renderBar() {
	const s = cur && srcOf(cur.sid),
		changed = dirtyFiles().length;
	$("railbtn").replaceChildren(icon("list", 16));
	$("railbtn").title = T("bar.rail.title");
	$("railbtn").setAttribute("aria-label", T("bar.rail.aria"));
	$("railbtn").setAttribute("aria-pressed", String(sideOpen && sidePinned));
	$("switch").replaceChildren(
		...(mix
			? [
					h("span", { class: cls("scope", s.kind === "user" && "user") }, scopeLabel(s)),
					h("span", { class: "nm" }, mix.name || T("bar.untitled")),
					icon("chev", 12),
				]
			: [h("span", { class: "nm" }, T("bar.none")), icon("chev", 12)]),
	);
	$("switch").title = mix ? T("bar.switch.title", { path: s.displayPath }) : T("bar.switch.none");
	$("addr").hidden = !mix;
	if (mix) {
		$("addr").textContent = "mixture/" + mix.name;
		$("addr").title = T("bar.addr.title");
	}
	const cell = (label, value, state, one) =>
		h("span", { class: one ? "one" : null }, h("b", {}, label), h("em", { class: state }, h("i"), value));
	const draftWord = changed ? TN("bar.draft.changed", changed) : T("bar.draft.clean"),
		theirs = s && fileOf(s.id)?.theirs;
	const [roster, rosterState] = mix ? rosterWord() : ["", ""];
	$("ledger").hidden = !mix;
	$("ledger").title = T("bar.ledger.title");
	if (mix)
		$("ledger").replaceChildren(
			cell(T("bar.draft"), draftWord, changed ? "hot" : "good"),
			cell(
				T("bar.disk"),
				theirs
					? T("bar.disk.changed")
					: fileOf(s.id).base.exists
						? short(fileOf(s.id).base.hash)
						: T("bar.disk.absent"),
				theirs ? "lag" : "",
			),
			cell(T("bar.roster"), roster, rosterState),
			cell(
				T("bar.draft"),
				theirs ? T("bar.disk.changed") : draftWord,
				theirs ? "lag" : changed ? "hot" : "good",
				true,
			),
		);
	const errors = issues.filter(i => i.sev === "e").length,
		warns = issues.filter(i => i.sev === "w").length;
	$("notes").hidden = !mix;
	$("notes").replaceChildren(
		...(errors || warns
			? [
					errors > 0 && h("span", { class: "count e" }, "!" + errors),
					warns > 0 && h("span", { class: "count w" }, "~" + warns),
					h("span", {}, TN("bar.issues", errors + warns)),
				]
			: [
					h(
						"span",
						{ style: { color: server.pending ? "var(--ink3)" : "var(--ok)", display: "flex" } },
						icon(server.pending ? "dots" : "check"),
					),
					h("span", {}, server.pending ? T("bar.checking") : T("bar.noIssues")),
				]
		).filter(Boolean),
	);
	$("save").replaceChildren(changed ? T("bar.save") : T("bar.saved"));
	$("save").classList.toggle("primary", changed > 0);
	$("save").title = changed ? T("bar.save.title") : T("bar.saved.title");
	$("reopen").replaceChildren(icon("side"), T("bar.inspector"));
	$("limits").hidden = !mix;
	if (mix) {
		const L = mix.limits ?? {},
			lt = limitTarget(),
			actn = onLimit(),
			budget = L.budgetUsd ?? D().budgetUsd;
		$("limits").title = T("bar.limits.title");
		$("limits").replaceChildren(
			icon("hour", 13),
			h("b", {}, T("bar.limits.hops", { n: L.maxHops ?? D().maxHops })),
			h("span", { class: "sep" }),
			h("span", {}, T("bar.limits.minutes", { n: L.wallClockMinutes ?? D().wallClockMinutes })),
			h("span", { class: "sep" }),
			h("span", {}, budget > 0 ? T("bar.limits.budget", { n: budget }) : T("bar.limits.noBudget")),
			h("span", { class: "sep" }),
			h(
				"span",
				{},
				actn === "judge" && lt
					? TX("bar.limits.judge", { id: lt.id })
					: actn === "stop"
						? TX("bar.limits.stop")
						: TX("bar.limits.pause"),
			),
		);
	}
	/* Everything that floats over the canvas is centred on the part of it that is not covered, and gets terser
     when that part is narrow: a pinned list and an open inspector leave less room than the window width suggests. */
	const [cx] = viewCenter(),
		ins = insets(),
		room = canvas.clientWidth - ins.l - ins.r;
	for (const el of [canvas, layer]) {
		el.style.setProperty("--cx", cx + "px");
		el.style.setProperty("--sl", ins.l + "px");
		el.style.setProperty("--room", room + "px");
	}
	canvas.dataset.room = room < 470 ? "xs" : room < 860 ? "s" : room < 1010 ? "m" : "l";
	document.title = (changed ? "● " : "") + (mix ? mix.name + " · " : "") + T("app.title");
}
function legend() {
	const line = (dash, color, w = 30) => {
		const s = svgEl("svg", { width: w, height: 8 });
		s.append(
			svgEl("path", {
				d: `M1 4H${w - 1}`,
				stroke: color,
				"stroke-width": 1.8,
				"stroke-dasharray": dash,
				"stroke-linecap": "round",
				fill: "none",
			}),
		);
		return s;
	};
	$("key").replaceChildren(
		h("span", { title: T("key.always.title") }, line("", "var(--wire)"), T("key.always")),
		h("span", { title: T("key.judge.title") }, line("6 5", "var(--judge)"), T("key.judge")),
		h("span", { title: T("key.limit.title") }, line("1.5 5", "var(--ink3)"), T("key.limit")),
	);
	const z = (ic, title, run) =>
		h("button", { type: "button", title, "aria-label": title, onclick: run }, icon(ic, 13));
	$("zoom").replaceChildren(
		z("plus", T("zoom.in"), () => zoomAt(cam.z * 1.2)),
		h("output", { title: T("zoom.reset"), onclick: () => zoomAt(1) }),
		z("minus", T("zoom.out"), () => zoomAt(cam.z / 1.2)),
		z("fit", T("zoom.fit"), () => fit(true)),
	);
	canvas.setAttribute("aria-label", T("canvas.aria"));
	$("panel").setAttribute("aria-label", T("panel.aria"));
	side.setAttribute("aria-label", T("side.aria"));
	$("dock").setAttribute("aria-label", T("dock.aria"));
	$("edge").title = T("edge.title");
}
$("railbtn").onclick = toggleSide;
$("switch").onclick = () => {
	if (sideOpen && !sidePinned) closeSide(true);
	else if (!sideOpen) openSide();
};
$("addr").onclick = () => {
	navigator.clipboard?.writeText("mixture/" + mix.name).then(
		() => toast(T("bar.addr.copied", { name: mix.name })),
		() => {},
	);
};
$("limits").onclick = () => select(null, { section: "limits" });
$("reopen").onclick = () => {
	panelOpen = true;
	render();
	if (!camTouched) fit(true);
};
$("save").onclick = () => openSave();
$("notes").onclick = () =>
	togglePop(
		$("notes"),
		() => {
			if (!issues.length)
				return h(
					"div",
					{ class: "pad" },
					h("b", {}, T("notes.none")),
					h(
						"p",
						{ class: "hint", style: { marginTop: "4px" } },
						server.failed ? T("notes.stale") : T("notes.none.hint"),
					),
				);
			const order = { e: 0, w: 1, i: 2 };
			return [
				h("h4", {}, T("notes.title")),
				h(
					"div",
					{ class: "scroll", style: { display: "grid", gap: "6px", padding: "2px" } },
					[...issues]
						.sort((a, b) => order[a.sev] - order[b.sev])
						.map(i =>
							h(
								"div",
								{ class: "issue " + i.sev, onclick: () => goIssue(i) },
								flagMark(i.sev),
								h(
									"span",
									{},
									h(
										"small",
										{},
										i.kind === "mix"
											? T("notes.where.mix")
											: i.kind === "edge"
												? (e => (e ? `${e.from} → ${targets(e).join(" + ")}` : ""))(edge(i.id))
												: i.id,
										i.locked && " · " + i.locked,
									),
									i.msg,
								),
							),
						),
				),
			];
		},
		{ align: "right", width: 420 },
	);
$("ledger").onclick = () =>
	togglePop(
		$("ledger"),
		() => {
			const s = srcOf(cur.sid),
				f = fileOf(s.id),
				changed = dirtyFiles(),
				row = diskRow(),
				other = row?.shadowedBy && srcOf(row.shadowedBy);
			const same = sources.filter(x => fileOf(x.id)?.doc.mixtures.some(m => m.name === mix.name && !isScratch(m)));
			return h(
				"div",
				{ class: "pad" },
				h(
					"dl",
					{ class: "receipt" },
					h("dt", {}, T("rcpt.draft")),
					h(
						"dd",
						{},
						changed.length
							? T("rcpt.draft.changed", { paths: changed.map(x => x.displayPath).join(", ") })
							: T("rcpt.draft.clean"),
					),
					h("dt", {}, T("rcpt.file")),
					h(
						"dd",
						{},
						h("code", {}, s.path),
						h(
							"div",
							{ class: "chain" },
							sources.map(x =>
								h(
									"div",
									{ class: x === same.at(-1) ? "win" : "" },
									h("span", {}, x.displayPath),
									h(
										"small",
										{},
										scopeWord(x),
										same.includes(x)
											? x === same.at(-1)
												? " · " + T("rcpt.file.wins", { name: mix.name })
												: " · " + T("rcpt.file.loses")
											: "",
									),
								),
							),
						),
					),
					h("dt", {}, T("rcpt.disk")),
					h(
						"dd",
						{},
						f.theirs
							? TX("rcpt.disk.changed")
							: f.base.exists
								? TX("rcpt.disk.hash", { hash: short(f.base.hash) })
								: T("rcpt.disk.absent"),
					),
					h("dt", {}, T("rcpt.roster")),
					h(
						"dd",
						{},
						!row
							? T("roster.new")
							: row.status === "registered"
								? TX("rcpt.roster.registered", { name: row.name, rev: row.revision ?? "?" })
								: row.status === "shadowed"
									? TX("rcpt.roster.shadowed", { path: other?.displayPath ?? "?" })
									: row.status === "invalid"
										? TX("rcpt.roster.invalid")
										: row.status === "unregistered"
											? TX("rcpt.roster.unregistered")
											: TX("rcpt.roster.unknown"),
					),
					h("dt", {}, T("rcpt.session")),
					h(
						"dd",
						{},
						boot.selected == null
							? TX("rcpt.session.unknown")
							: boot.selected === row?.name && row.status === "registered"
								? TX("rcpt.session.this", { name: row.name })
								: T("rcpt.session.other"),
					),
					h("dt", {}, T("rcpt.unchecked")),
					h("dd", {}, TX("rcpt.unchecked.body")),
				),
				h("p", { class: "hint", style: { marginTop: "12px" } }, T("rcpt.foot")),
			);
		},
		{ align: "right", width: 460 },
	);
function renderBanner() {
	const el = $("banner"),
		f = cur && fileOf(cur.sid);
	const show = (text, label, run) => {
		el.hidden = false;
		el.replaceChildren(
			icon("warn"),
			h("span", {}, text),
			label && h("button", { class: "btn small", type: "button", onclick: run }, label),
		);
	};
	if (offline > 1) return show(T("banner.offline"), T("banner.retry"), () => reloadAll(false));
	if (f?.theirs)
		return show(T("banner.conflict", { path: srcOf(cur.sid).displayPath }), T("banner.conflict.go"), () =>
			openSave(),
		);
	el.hidden = true;
}

/* ═══════════════════════════ DOCK ═══════════════════════════ */
function renderDock() {
	const b = (ic, label, key, run, o = {}) =>
		h(
			"button",
			{
				type: "button",
				class: o.cls,
				title: o.title,
				disabled: o.disabled,
				"aria-pressed": o.pressed == null ? null : String(o.pressed),
				"aria-label": label || o.title,
				onclick: run,
			},
			icon(ic),
			label && h("span", {}, label),
			key && h("kbd", {}, key),
		);
	const none = !mix,
		locked = none || !!trial || readOnly(),
		empty = none || !mix.members.length;
	$("dock").replaceChildren(
		b("spark", T("add.model"), "M", () => createAt("model", ...centerSpot()), {
			cls: "lead",
			disabled: locked,
			title: T("dock.model.title"),
		}),
		b("scale", T("add.verdict"), "V", () => createAt("verdict", ...centerSpot()), {
			cls: "lead",
			disabled: locked,
			title: T("dock.verdict.title"),
		}),
		b(
			"link",
			T("dock.connect"),
			"C",
			() =>
				connect
					? endConnect()
					: startConnect({ from: sel?.kind === "node" && isModel(node(sel.id)) ? sel.id : null }),
			{ pressed: !!connect, disabled: locked || empty, title: T("dock.connect.title") },
		),
		h("span", { class: "sep" }),
		b("tidy", T("dock.tidy"), "T", tidyUp, { disabled: empty || !!trial, title: T("dock.tidy.title") }),
		b("undo", null, null, undo, {
			cls: "icon",
			disabled: !undoStack.length || !!trial,
			title: undoStack.length ? T("dock.undo", { label: undoStack.at(-1).label }) : T("dock.undo.none"),
		}),
		b("redo", null, null, redo, {
			cls: "icon",
			disabled: !redoStack.length || !!trial,
			title: redoStack.length ? T("dock.redo", { label: redoStack.at(-1).label }) : T("dock.redo.none"),
		}),
		h("span", { class: "sep" }),
		b("play", T("dock.trial"), "R", () => (trial ? trialEnd() : trialStart()), {
			cls: "go",
			pressed: !!trial,
			disabled: empty,
			title: T("dock.trial.title"),
		}),
		b("search", null, "/", openFind, { cls: "icon", disabled: empty, title: T("dock.find.title") }),
		b("info", null, "?", openKeys, { cls: "icon", title: T("dock.help.title") }),
	);
	renderHint();
}
/* One quiet line above the dock that always says what the next gesture is. */
function renderHint() {
	const el = $("hint"),
		k = key => h("kbd", {}, key),
		plus = () => h("span", { class: "pl" }, icon("plus", 9));
	el.hidden = !mix || !!trial || !!connect || !mix.members.length;
	if (el.hidden) return;
	const n = sel?.kind === "node" && node(sel.id),
		e = sel?.kind === "edge" && edge(sel.id),
		v = {
			plus,
			sep: () => h("i"),
			enter: () => k("Enter"),
			del: () => k("Del"),
			up: () => k("↑"),
			down: () => k("↓"),
		};
	el.replaceChildren(
		...(readOnly()
			? TX("hint.readOnly", v)
			: multi.size
				? TX("hint.multi", v)
				: n && isModel(n)
					? TX("hint.model", v)
					: n
						? TX("hint.verdict", v)
						: e && !isFan(e)
							? TX("hint.path", v)
							: e
								? TX("hint.fanout", v)
								: TX("hint.idle", v)),
	);
}

/* ═══════════════════════════ EMPTY STATES ═══════════════════════════ */
const pickSelector = (...wanted) =>
	wanted.map(w => boot.models.find(m => m.selector === w)?.selector).find(Boolean) ?? boot.models[0]?.selector ?? "";
const STARTERS = [
	{
		name: () => T("starter.chain"),
		blurb: () => T("starter.chain.blurb"),
		mini: [
			[0, 1],
			[1, 2],
		],
		cols: [0, 1, 2],
		build: () => ({
			entry: "draft",
			members: [
				{
					id: "draft",
					description: "Writes the first answer.",
					model: pickSelector("@task", "@default"),
					systemPrompt: "Answer the request as well as you can.",
					tools: false,
				},
				{
					id: "critique",
					description: "Finds what is wrong or missing.",
					model: pickSelector("@slow", "@task"),
					role: "prosecution",
					tools: false,
				},
				{
					id: "finalize",
					description: "Writes the final answer from the draft and its critique.",
					model: pickSelector("@task", "@default"),
					systemPrompt: "Write the final answer. Use the draft, and fix everything the critique got right.",
					tools: false,
				},
			],
			edges: [
				{ from: "draft", to: "critique", x: { output: true } },
				{ from: "critique", to: "finalize", x: { output: true, transcript: true } },
			],
		}),
	},
	{
		name: () => T("starter.pick"),
		blurb: () => T("starter.pick.blurb"),
		mini: [
			[0, 1],
			[0, 2],
		],
		cols: [0, 1, 1],
		cond: true,
		build: () => ({
			entry: "draft",
			members: [
				{
					id: "draft",
					description: "Writes the first answer.",
					model: pickSelector("@task", "@default"),
					systemPrompt: "Answer the request as well as you can.",
					tools: false,
					route: { instructions: "Read the draft. Pick the reviewer whose speciality it needs most." },
				},
				{
					id: "code-review",
					description: "Reviews correctness and edge cases.",
					model: pickSelector("@slow", "@task"),
					systemPrompt: "Review the draft for correctness. Return a corrected version.",
					tools: false,
				},
				{
					id: "prose-review",
					description: "Reviews clarity and tone.",
					model: pickSelector("@smol", "@task"),
					systemPrompt: "Review the draft for clarity. Return an improved version.",
					tools: false,
				},
			],
			edges: [
				{
					from: "draft",
					to: "code-review",
					when: "The draft is mostly code or technical claims",
					x: { output: true },
				},
				{ from: "draft", to: "prose-review", when: "The draft is mostly explanation", x: { output: true } },
			],
		}),
	},
	{
		name: () => T("starter.loop"),
		blurb: () => T("starter.loop.blurb"),
		mini: [
			[0, 1],
			[1, 2],
			[1, 0],
		],
		cols: [0, 1, 2],
		cond: true,
		verdict: 2,
		build: () => ({
			entry: "draft",
			members: [
				{
					id: "draft",
					description: "Writes, and rewrites when asked.",
					model: pickSelector("@task", "@default"),
					systemPrompt: "Answer the request. If a review is attached, fix what it found.",
					tools: false,
				},
				{
					id: "review",
					description: "Decides whether the draft is good enough.",
					model: pickSelector("@slow", "@task"),
					role: "prosecution",
					tools: false,
					route: {
						instructions: "Read the review. Pick the path whose condition matches its conclusion.",
						fallback: "review->grade",
					},
				},
				{
					id: "grade",
					kind: "verdict",
					question: {
						type: "score",
						instructions: "How well does the final draft answer the request?",
						criteria: [
							"Does not answer it",
							"Partly answers it",
							"Answers it",
							"Answers it and anticipates follow-ups",
						],
					},
				},
			],
			edges: [
				{ from: "draft", to: "review", x: { output: true } },
				{
					from: "review",
					to: "draft",
					when: "Something still needs fixing",
					maxTraversals: 3,
					x: { output: true },
				},
				{ from: "review", to: "grade", when: "Good enough to grade", x: { output: true, input: true } },
			],
		}),
	},
];
function miniSvg(s) {
	const svg = svgEl("svg", { class: "mini", viewBox: "0 0 200 64" }),
		rows = {};
	const pos = s.cols
		.map(c => {
			const r = (rows[c] = (rows[c] ?? 0) + 1);
			return { c, r };
		})
		.map(({ c, r }) => {
			const n = s.cols.filter(x => x === c).length;
			return [22 + c * 66, 32 + (r - (n + 1) / 2) * 30];
		});
	for (const [a, b] of s.mini) {
		const [x1, y1] = pos[a],
			[x2, y2] = pos[b],
			back = x2 < x1,
			judged = s.cond && (back || s.mini.filter(m => m[0] === a).length > 1);
		svg.append(
			svgEl("path", {
				d: back
					? `M${x1 + 10} ${y1 + 9}V54H${x2 + 10}V${y2 + 9}`
					: `M${x1 + 38} ${y1}H${(x1 + 38 + x2) / 2}V${y2}H${x2}`,
				fill: "none",
				stroke: judged ? "var(--judge)" : "var(--wire)",
				"stroke-width": 1.5,
				"stroke-dasharray": judged ? "4 3" : null,
			}),
		);
	}
	pos.forEach(([x, y], i) =>
		svg.append(
			svgEl("rect", {
				x,
				y: y - 9,
				width: 38,
				height: 18,
				rx: i === s.verdict ? 9 : 5,
				fill: "var(--surface3)",
				stroke: i === 0 ? "var(--flow)" : i === s.verdict ? "var(--judge)" : "var(--line3)",
				"stroke-width": 1.2,
			}),
		),
	);
	return svg;
}
function renderEmpty() {
	const el = $("empty"),
		k = key => h("kbd", {}, key);
	if (mix && (mix.members.length || readOnly())) {
		el.hidden = true;
		return;
	}
	el.hidden = false;
	if (mix) {
		el.replaceChildren(
			h(
				"div",
				{},
				h("h2", {}, T("empty.title")),
				h("p", {}, TX("empty.body", { m: k("M") })),
				h(
					"div",
					{ class: "starters" },
					STARTERS.map(s =>
						h(
							"button",
							{
								class: "starter",
								type: "button",
								onclick: () => {
									commit(
										T("act.starter", { name: s.name() }),
										() => {
											const made = s.build();
											for (const e of made.edges) e.$k = "k" + ++edgeSeq;
											Object.assign(mix, made);
											mix.description ??= s.blurb();
											sel = null;
										},
										{ quiet: true },
									);
									fit(true);
								},
							},
							miniSvg(s),
							h("b", {}, s.name()),
							h("span", {}, s.blurb()),
						),
					),
				),
			),
		);
		return;
	}
	const targetsHere = sources.filter(writable);
	el.replaceChildren(
		h(
			"div",
			{},
			h("h2", {}, T("welcome.title")),
			h("p", {}, T("welcome.body")),
			targetsHere.length
				? h(
						"div",
						{ class: "welcome" },
						targetsHere.map(s =>
							h(
								"button",
								{ class: "starter", type: "button", onclick: () => newMixture(s.id) },
								h("b", {}, s.kind === "user" ? T("welcome.user") : T("welcome.project")),
								h("span", {}, s.kind === "user" ? T("welcome.user.blurb") : T("welcome.project.blurb")),
								h(
									"span",
									{ class: "mono", style: { marginTop: "8px", fontSize: "11px" }, title: s.path },
									s.displayPath,
								),
							),
						),
					)
				: h("p", {}, T("welcome.none")),
		),
	);
}

/* ═══════════════════════════ FIND · HELP ═══════════════════════════ */
function openFind() {
	if (!mix) return;
	const input = h("input", {
			class: "in",
			placeholder: T("find.placeholder"),
			spellcheck: "false",
			autocomplete: "off",
		}),
		list = h("div", { class: "scroll" });
	let hits = [],
		at = 0;
	const fill = () => {
		const qy = input.value.trim().toLowerCase(),
			has = (...xs) =>
				!qy ||
				xs.some(x =>
					String(x ?? "")
						.toLowerCase()
						.includes(qy),
				);
		hits = [
			...mix.members
				.filter(n => has(n.id, n.description, n.systemPrompt, n.question?.instructions, n.model, n.role))
				.map(n => ({
					key: { kind: "node", id: n.id },
					ic: kindIcon(n),
					label: n.id,
					hint: isModel(n) ? n.model : T("card.verdict"),
				})),
			...mix.edges
				.filter(e => has(e.id, e.when, e.from, ...targets(e), e.envelope))
				.map(e => ({
					key: { kind: "edge", id: e.$k },
					ic: "right",
					label: `${e.from} → ${targets(e).join(" + ")}`,
					hint: e.when,
				})),
		];
		at = clamp(at, 0, Math.max(0, hits.length - 1));
		list.replaceChildren(
			...(hits.length
				? hits.map((x, i) =>
						mi(x.ic, x.label, () => select(x.key), { hint: x.hint?.slice(0, 48), mono: true, on: i === at }),
					)
				: [h("div", { class: "pad hint" }, T("find.none"))]),
		);
	};
	input.addEventListener("input", () => {
		at = 0;
		fill();
	});
	input.addEventListener("keydown", ev => {
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			ev.preventDefault();
			at += ev.key === "ArrowDown" ? 1 : -1;
			fill();
			list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
		}
		if (ev.key === "Enter" && hits[at]) {
			closePop();
			select(hits[at].key);
		}
	});
	fill();
	const r = canvas.getBoundingClientRect(),
		[cx] = viewCenter();
	openPop(null, [input, list], { at: [r.left + cx - 230, r.top + 70], width: 460 });
	input.focus();
}
function openKeys() {
	const row = (what, ...keys) =>
		h(
			"div",
			{},
			what,
			h(
				"span",
				{},
				keys.map(key => h("kbd", {}, key)),
			),
		);
	const line = (dash, color) => {
		const s = svgEl("svg", { width: 34, height: 10 });
		s.append(
			svgEl("path", {
				d: "M1 5H33",
				stroke: color,
				"stroke-width": 1.8,
				"stroke-dasharray": dash,
				"stroke-linecap": "round",
				fill: "none",
			}),
		);
		return s;
	};
	const read = (glyph, title, body, when) =>
		h(
			"div",
			{},
			h("span", { class: "g" }, glyph),
			h("span", {}, h("b", {}, title), h("span", { class: "ms" }, when), h("small", {}, body)),
		);
	const today = T("help.today");
	openSheet({
		width: 780,
		title: T("help.title"),
		sub: T("help.sub"),
		body: [
			h(
				"div",
				{ class: "reading" },
				read(line("", "var(--wire)"), T("help.always"), T("help.always.body"), today),
				read(line("6 5", "var(--judge)"), T("help.judge"), T("help.judge.body"), today),
				read(icon("diamondo"), T("help.stop"), T("help.stop.body"), today),
				read(h("span", { class: "capx" }, "≤3×"), T("help.cap"), T("help.cap.body"), today),
				read(line("1.5 5", "var(--ink3)"), T("help.limit"), T("help.limit.body"), today),
				read(icon("lock"), T("help.several"), T("help.several.body"), "M4"),
			),
			h(
				"div",
				{ class: "keys", style: { borderTop: "1px solid var(--line)", paddingTop: "10px" } },
				row(T("help.k.model"), "M"),
				row(T("help.k.verdict"), "V"),
				row(T("help.k.connect"), "C"),
				row(T("help.k.rename"), "Enter"),
				row(T("help.k.move"), "←", "↑", "↓", "→"),
				row(T("help.k.next"), "↑", "↓"),
				row(T("help.k.delete"), "Del"),
				row(T("help.k.duplicate"), "D"),
				row(T("help.k.undo"), "Ctrl", "Z"),
				row(T("help.k.save"), "Ctrl", "S"),
				row(T("help.k.tidy"), "T"),
				row(T("help.k.fit"), "F"),
				row(T("help.k.trial"), "R"),
				row(T("help.k.find"), "/"),
				row(T("help.k.list"), "B"),
				row(T("help.k.inspector"), "I"),
				row(T("help.k.back"), "Esc"),
			),
			h(
				"div",
				{ class: "keys", style: { borderTop: "1px solid var(--line)", paddingTop: "10px" } },
				row(T("help.g.connect"), T("help.g.connect.how")),
				row(T("help.g.create"), T("help.g.create.how")),
				row(T("help.g.retarget"), T("help.g.retarget.how")),
				row(T("help.g.start"), T("help.g.start.how")),
				row(T("help.g.add"), T("help.g.add.how")),
				row(T("help.g.rename"), T("help.g.rename.how")),
				row(T("help.g.select"), T("help.g.select.how")),
				row(T("help.g.pan"), T("help.g.pan.space"), T("help.g.pan.middle")),
				row(T("help.g.zoom"), T("help.g.zoom.how")),
				row(T("help.g.moveMix"), T("help.g.moveMix.how")),
			),
		],
		note: T("help.note"),
		cancel: null,
		primary: { label: T("common.done"), run: closeSheet },
	});
}

/* ═══════════════════════════ TRIAL RUN ═══════════════════════════
   Walks the graph in the engine's order: stop check, then which paths are still eligible, then 0 / 1 / pick.
   No model is called. You play the judge, so every branch, cap and limit can be tried in seconds. */
function trialStart() {
	if (!mix) return;
	if (!isModel(node(mix.entry))) return toast(T("trial.noEntry"), { bad: true });
	endConnect();
	closePop();
	sel = null;
	multi.clear();
	if (stacked()) panelOpen = false; // in a narrow window the trial takes the inspector's place
	trial = {
		at: mix.entry,
		used: {},
		walked: new Set(),
		trail: [mix.entry],
		hops: 1,
		choices: [],
		phase: null,
		endRow: null,
		over: null,
		stopped: false,
	};
	trialStep();
	render();
	fit(true);
}
function trialEnd() {
	trial = null;
	render();
	fit(true);
}
const usedUp = e => cap(e) !== undefined && (trial.used[e.$k] ?? 0) >= cap(e);
function trialStep() {
	const n = node(trial.at);
	trial.choices = [];
	trial.phase = null;
	if (!isModel(n)) {
		trial.over = "verdict";
		trial.endRow = n.id + "/:final";
		return;
	}
	if (n.terminate && !trial.stopped) {
		trial.phase = "stop";
		return;
	}
	const livePaths = liveOuts(n.id),
		open = livePaths.filter(e => !usedUp(e) && node(e.to));
	if (!livePaths.length && outs(n.id).length) {
		trial.over = "locked";
		return;
	}
	if (!open.length) {
		trial.over = livePaths.length ? "spent" : "final";
		trial.endRow = n.id + "/" + (livePaths.length ? ":ends" : ":final");
		return;
	}
	trial.phase = open.length === 1 ? "auto" : "pick";
	trial.choices = open.map(e => e.$k);
}
function trialStop(yes) {
	if (yes) {
		trial.over = "stop";
		trial.endRow = trial.at + "/:stop";
		trial.phase = null;
	} else {
		trial.stopped = true;
		trialStep();
	}
	render();
}
function trialTake(e) {
	const max = mix.limits?.maxHops ?? D().maxHops,
		lt = limitTarget();
	trial.choices = [];
	trial.phase = null;
	if (trial.hops >= max) {
		if (onLimit() === "judge" && lt && lt.id !== trial.at) {
			trial.at = lt.id;
			trial.trail.push(lt.id);
			trial.over = "limit-judge";
			trial.endRow = lt.id + "/:final";
		} else trial.over = onLimit() === "pause" ? "limit-pause" : "limit-stop";
		render();
		if (trial.over === "limit-judge") reveal(trial.at);
		return;
	}
	trial.used[e.$k] = (trial.used[e.$k] ?? 0) + 1;
	trial.walked.add(e.$k);
	trial.hops++;
	trial.at = e.to;
	trial.trail.push(e.to);
	trial.stopped = false;
	trialStep();
	render();
	reveal(e.to);
}
function trialUnsure() {
	const fb = node(trial.at).route?.fallback,
		e = fb && liveOuts(trial.at).find(x => eid(x) === fb);
	if (e && trial.choices.includes(e.$k)) return trialTake(e);
	trial.over = "unsure";
	trial.choices = [];
	trial.phase = null;
	render();
}
function renderTrial() {
	const box = $("trial");
	box.hidden = !trial;
	if (!trial) return;
	const n = node(trial.at),
		max = mix.limits?.maxHops ?? D().maxHops,
		id = n.id;
	const opt = (label, run, o = {}) =>
		h(
			"button",
			{ type: "button", class: o.cls, onclick: run },
			o.key && h("kbd", {}, o.key),
			h("span", {}, label),
			o.hint && h("small", {}, o.hint),
		);
	let say,
		opts = [];
	if (trial.phase === "stop") {
		say = TX("trial.stop", { id, text: n.terminate.instructions || T("trial.stop.blank") });
		opts = [
			opt(T("trial.stop.yes"), () => trialStop(true), { key: "1", cls: "j" }),
			opt(T("trial.stop.no"), () => trialStop(false), { key: "2", cls: "j" }),
		];
	} else if (trial.phase === "auto") {
		const e = edge(trial.choices[0]),
			others = liveOuts(id).length - 1;
		say = others ? TX("trial.auto.left", { id }) : TX("trial.auto", { id });
		opts = [
			opt(T("trial.continue", { to: e.to }), () => trialTake(e), {
				key: "1",
				cls: "go",
				hint: cap(e) !== undefined ? T("trial.used", { n: trial.used[e.$k] ?? 0, max: cap(e) }) : null,
			}),
		];
	} else if (trial.phase === "pick") {
		const fb = n.route?.fallback,
			fbEdge = fb && liveOuts(id).find(x => eid(x) === fb),
			fbOpen = fbEdge && trial.choices.includes(fbEdge.$k);
		say = TX("trial.pick", { id });
		opts = [
			...trial.choices.map((key, i) => {
				const e = edge(key);
				return opt(e.when?.trim() || T("trial.noWhen"), () => trialTake(e), {
					key: String(i + 1),
					cls: "j",
					hint: "→ " + e.to + (cap(e) !== undefined ? ` · ${trial.used[key] ?? 0}/${cap(e)}` : ""),
				});
			}),
			opt(T("trial.unsure"), trialUnsure, {
				key: String(trial.choices.length + 1),
				hint: fbOpen ? T("trial.unsure.follows", { to: fbEdge.to }) : T("trial.unsure.pauses"),
			}),
		];
	} else {
		say = {
			verdict: TX("trial.end.verdict", { id }),
			final: TX("trial.end.final", { id }),
			spent: TX("trial.end.spent", { id }),
			stop: TX("trial.end.stop", { id }),
			locked: TX("trial.end.locked", { id }),
			unsure: TX("trial.end.unsure", { id }),
			"limit-pause": TX("trial.end.limitPause", { max }),
			"limit-stop": TX("trial.end.limitStop", { max }),
			"limit-judge": TX("trial.end.limitJudge", { max, id }),
		}[trial.over];
		opts = [
			opt(T("trial.again"), trialStart, { key: "1", cls: "go" }),
			opt(T("common.done"), trialEnd, { key: "2" }),
		];
	}
	const trail = h(
		"div",
		{ class: "trail" },
		trial.trail.flatMap((step, i) => [
			i > 0 && "›",
			h("b", { class: cls(i === trial.trail.length - 1 && (trial.over ? "end" : "now")) }, step),
		]),
		trial.over && !/unsure|pause|locked/.test(trial.over) && ["›", h("b", { class: "end" }, T("trial.answer"))],
	);
	box.replaceChildren(
		h(
			"header",
			{},
			h("span", { style: { color: "var(--flow)", display: "flex" } }, icon("play")),
			h("b", {}, T("dock.trial")),
			h("span", {}, T("trial.sub")),
			h("span", { class: "sp" }),
			h(
				"span",
				{ class: cls("hops", trial.hops >= max && "hot"), title: T("trial.hops.title") },
				T("trial.hops", { n: trial.hops, max }),
			),
			h(
				"button",
				{ class: "icon-btn", type: "button", title: T("trial.restart"), onclick: trialStart },
				icon("loop"),
			),
			h("button", { class: "icon-btn", type: "button", title: T("trial.close"), onclick: trialEnd }, icon("x")),
		),
		trail,
		h("div", { class: "ask" }, h("p", {}, say), h("div", { class: "opts" }, opts)),
	);
}
document.addEventListener(
	"keydown",
	ev => {
		if (
			!trial ||
			sheetEl ||
			popEl ||
			ev.ctrlKey ||
			ev.metaKey ||
			ev.altKey ||
			/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)
		)
			return;
		const buttons = [...$("trial").querySelectorAll(".opts button")],
			i = ev.key === "Enter" ? 0 : /^[1-9]$/.test(ev.key) ? +ev.key - 1 : -1;
		if (buttons[i]) {
			ev.preventDefault();
			ev.stopPropagation();
			buttons[i].click();
		}
	},
	true,
);

/* ═══════════════════════════ FRAME ═══════════════════════════ */
function render() {
	issues = mix ? [...check(), ...serverFindings()] : [];
	renderGraph();
	renderPanel();
	renderBar();
	renderDock();
	renderTrial();
	renderSide();
	renderBanner();
	if (connect) markTargets();
}
/* soft(): a keystroke (or the harness's answer) changed what is known. Redraw what depends on it,
   but leave the field being typed in alone. */
function soft() {
	if (!mix) return render();
	if (document.querySelector(".nid-edit") || gesture || connect) return setTimeout(soft, 250); // never rebuild cards under a rename or a drag
	issues = [...check(), ...serverFindings()];
	renderGraph();
	renderBar();
	renderDock();
	renderSide();
	renderBanner();
	for (const update of liveList) update();
}
addEventListener("resize", () => {
	renderBar();
	if (!camTouched) fit();
});
addEventListener("beforeunload", ev => {
	if (dirty()) ev.preventDefault();
});

function normalizeBoot(data) {
	const d = data.defaults ?? {},
		lim = data.limits ?? {};
	return {
		...data,
		models: (data.models ?? []).map(m => (typeof m === "string" ? { selector: m } : m)),
		judgePlan: data.judgePlan ?? null,
		selected: data.selected ?? null,
		summaryModel: data.summaryModel ?? d.summaryModel ?? null,
		bundled: {
			roles: data.bundled?.roles ?? {},
			envelopes: data.bundled?.envelopes ?? {},
			partial: data.bundled?.partial ?? data.bundled?.partials?.["moa-parts"] ?? "",
		},
		limits: { members: lim.members ?? 32, edges: lim.edges ?? 128 },
		defaults: {
			maxHops: d.maxHops ?? 24,
			hardMaxHops: d.hardMaxHops ?? 200,
			budgetUsd: d.budgetUsd ?? 0,
			hardBudgetUsd: d.hardBudgetUsd ?? 0,
			wallClockMinutes: d.wallClockMinutes ?? 240,
			onLimit: d.onLimit ?? "pause",
			minConfidence: d.minConfidence ?? 0.55,
			threshold: d.threshold ?? 0.5,
		},
	};
}
async function start() {
	legend();
	$("empty").hidden = false;
	$("empty").replaceChildren(h("div", {}, h("p", {}, T("start.loading"))));
	const [b, list] = await Promise.all([api.bootstrap(), api.sources()]);
	if (!b.ok || !list.ok) {
		$("empty").replaceChildren(
			h(
				"div",
				{},
				h("h2", {}, T("start.failed")),
				h("p", {}, b.data?.error ?? list.data?.error ?? T("harness.silent")),
				h("button", { class: "btn primary", type: "button", onclick: () => location.reload() }, T("start.retry")),
			),
		);
		return;
	}
	boot = normalizeBoot(b.data);
	sources = list.data.sources ?? [];
	const snaps = await Promise.all(sources.map(s => loadSource(s.id)));
	sources = sources.filter((s, i) => {
		if (!snaps[i]) return false;
		files.set(s.id, { base: snaps[i], doc: adopt(snaps[i].doc, s.id), theirs: null });
		return true;
	});
	pickMixture();
	sync();
	panelOpen = !stacked();
	edited();
	render();
	fit();
	if (!mix) {
		sidePinned = !stacked();
		sideOpen = true;
		render();
	}
	watchDisk();
	document.body.dataset.ready = "";
}
document.fonts.ready.then(start);
