"use strict";
/* Mixture Studio · panel: the inspector for a mixture, a model, a verdict, a path, and the file tab.
   Rules of the house: nothing scrolls inside the panel but the panel itself; a value that moves with a control
   is shown next to that control; the actions for an object are always in the same place, right under its name. */

/* ═══════════════════════════ BUILDING BLOCKS ═══════════════════════════ */
let liveList = [];
function live(tag, attrs, fn) {
	const el = h(tag, attrs),
		update = () => el.replaceChildren(...[fn()].flat(Infinity).filter(x => x != null && x !== false && x !== ""));
	update();
	liveList.push(update);
	return el;
}
const selKey = () => (cur ? cur.sid + "/" + cur.index : "-") + (sel ? ":" + sel.kind + ":" + sel.id : "");
function sec(title, opts, ...kids) {
	return h(
		"section",
		{ class: "sec", "data-sec": opts?.id },
		h(
			"h3",
			{},
			title,
			opts?.n != null && h("span", { class: "n" }, opts.n),
			opts?.aside && h("small", {}, opts.aside),
		),
		kids,
	);
}
function fld(label, control, { hint, aside } = {}) {
	const plain = control?.matches?.("input,textarea,select");
	return h(
		plain ? "label" : "div",
		{ class: "fld" },
		label && h("span", {}, label, aside && h("small", {}, aside)),
		control,
		hint && h("p", {}, hint),
	);
}
/* Text areas grow with what is in them. Nothing to drag, nothing that scrolls on its own. */
function grow(el) {
	const fit2 = () => {
		el.style.height = "auto";
		el.style.height = el.scrollHeight + 2 + "px";
	};
	el.addEventListener("input", fit2);
	requestAnimationFrame(fit2);
	return el;
}
/* One text or number field bound to obj[key]. An emptied field removes the key (the file then has no such line)
   unless `keep`; `set` replaces the write entirely. Numbers that do not parse are kept out of the draft and marked. */
function text(obj, key, { k, placeholder, mono, area, rows, number, keep, field, set, label } = {}) {
	const id = (k ?? key) + "@" + fieldKey(),
		wrong = number ? badInputs.get(id) : null,
		name = field ?? (number ? "num-" + (k ?? key) : undefined);
	const el = h(area ? "textarea" : "input", {
		class: cls(area ? "ta" : "in", mono && "mono", wrong && "bad"),
		value: wrong?.text ?? obj?.[key] ?? "",
		placeholder,
		rows: area ? (rows ?? 1) : null,
		"data-field": name,
		autocomplete: "off",
		inputmode: number ? "decimal" : null,
		"aria-label": label,
		"aria-invalid": wrong ? "true" : null,
	});
	el.setAttribute("spellcheck", area && !mono ? "true" : "false");
	el.addEventListener("input", () => {
		let v = el.value;
		if (number) {
			const n = Number(v.trim().replace(",", ".")),
				bad = v.trim() !== "" && !Number.isFinite(n);
			el.classList.toggle("bad", bad);
			/* Not a number: the draft keeps its old value, and the page says so everywhere a save could be started from. */
			if (bad) {
				badInputs.set(id, {
					mix,
					kind: sel?.kind ?? "mix",
					id: sel?.id ?? null,
					field: name,
					label: label ?? key,
					text: v.trim(),
				});
				return soft();
			}
			if (badInputs.delete(id)) soft();
			v = v.trim() === "" ? "" : n;
		}
		typing(id, () => {
			if (set) return set(v === "" ? undefined : v);
			if (v === "" && !keep) delete obj[key];
			else obj[key] = v;
		});
	});
	return area ? grow(el) : el;
}
function seg(options, current, pick, attrs) {
	return h(
		"div",
		{ class: "seg", role: "group", ...attrs },
		options.map(([v, label, title]) =>
			h(
				"button",
				{ type: "button", "aria-pressed": String(v === current), title, onclick: () => v !== current && pick(v) },
				label,
			),
		),
	);
}
function choose(options, current, pick, attrs) {
	const el = h(
		"select",
		{ class: "sl", ...attrs },
		options.map(o => {
			const [v, label, disabled] = Array.isArray(o) ? o : [o, o];
			return h("option", { value: v, selected: v === current, disabled }, label);
		}),
	);
	el.addEventListener("change", () => pick(el.value));
	return el;
}
/* A 0..1 setting: a wide slider, a step either side of it, and the number itself, all in one row.
   The line under it says what the current value means, and offers the way back to the default. */
function range(obj, key, def, k, { label, explain } = {}) {
	const slider = h("input", { type: "range", min: "0", max: "1", step: "0.01", "aria-label": label }),
		num = h("input", { class: "in", inputmode: "decimal", "aria-label": label, autocomplete: "off" }),
		note = h("div", { class: "rnote" });
	const value = () => obj[key] ?? def,
		id = k + "@" + fieldKey(),
		owner = mix,
		at = { kind: sel?.kind ?? "mix", id: sel?.id ?? null };
	const paint = from => {
		const v = value(),
			custom = obj[key] !== undefined;
		slider.style.setProperty("--p", v * 100 + "%");
		if (from !== slider) slider.value = v;
		if (from !== num) num.value = v.toFixed(2);
		note.replaceChildren(
			h("span", {}, explain(v)),
			custom
				? h(
						"button",
						{
							class: "btn small ghost",
							type: "button",
							style: { marginLeft: "auto" },
							onclick: () =>
								commit(
									T("range.reset"),
									() => {
										delete obj[key];
									},
									{ quiet: true },
								),
						},
						T("range.useDefault", { v: def.toFixed(2) }),
					)
				: h("span", { style: { marginLeft: "auto", color: "var(--ink4)" } }, T("range.isDefault")),
		);
	};
	const set = (v, from) => {
		if (badInputs.delete(id)) num.classList.remove("bad");
		typing(id, () => {
			obj[key] = Math.round(clamp(v, 0, 1) * 100) / 100;
			paint(from);
		});
	};
	slider.addEventListener("input", () => set(+slider.value, slider));
	/* Something that is not a number from 0 to 1 never reaches the draft, and is an issue for as long as it is in the
     field. Leaving the field puts the real value back, which settles it. */
	num.addEventListener("input", () => {
		const raw = num.value.trim(),
			v = Number(raw.replace(",", ".")),
			good = raw !== "" && v >= 0 && v <= 1;
		num.classList.toggle("bad", !good);
		if (good) return set(v, num);
		badInputs.set(id, {
			mix: owner,
			...at,
			field: { threshold: "stop", confidence: "route" }[k],
			label: label ?? key,
			text: raw || T("range.blank"),
		});
		soft();
	});
	num.addEventListener("blur", () => {
		num.classList.remove("bad");
		paint();
		if (badInputs.delete(id)) soft();
	});
	const step = d =>
		h(
			"button",
			{
				type: "button",
				"aria-label": d < 0 ? T("range.less") : T("range.more"),
				onclick: () => set(Math.round((value() + d) * 20) / 20),
			},
			icon(d < 0 ? "minus" : "plus", 12),
		);
	paint();
	return [h("div", { class: "range" }, step(-0.05), slider, step(0.05), num), note];
}
function toggle(on, label, sub, flip) {
	return h(
		"button",
		{ class: "tog", type: "button", "aria-pressed": String(!!on), onclick: flip },
		h("i"),
		h("span", {}, label, sub && h("small", {}, sub)),
	);
}
function gated(ms, title, why, extra) {
	return h(
		"div",
		{ class: "gated" },
		icon("lock"),
		h("span", {}, h("b", {}, title), h("small", {}, why)),
		extra ?? h("span", { class: "ms" }, ms),
	);
}
const flagMark = sev => h("span", { class: "flag " + sev }, sev === "e" ? "!" : sev === "w" ? "~" : "i");
function issueList(list) {
	return h(
		"div",
		{ class: "pissues" },
		list.map(i =>
			h(
				"div",
				{ class: "issue " + i.sev, onclick: () => goIssue(i) },
				flagMark(i.sev),
				h(
					"span",
					{},
					i.msg,
					i.server && h("small", {}, T("issue.fromHarness")),
					i.fix &&
						!readOnly() &&
						h(
							"div",
							{ style: { marginTop: "6px" } },
							h(
								"button",
								{
									class: "btn small",
									type: "button",
									onclick: ev => {
										ev.stopPropagation();
										commit(i.fix.label, i.fix.run);
									},
								},
								i.fix.label,
							),
						),
				),
			),
		),
	);
}
function goIssue(i) {
	closePop();
	const section =
		{
			route: "paths",
			stop: "stop",
			limits: "limits",
			when: "when",
			parts: "parts",
			envelope: "envelope",
			cap: "when",
			tools: "tools",
			show: "show",
			criteria: "question",
			render: "render",
		}[i.field] ?? i.field;
	select(i.kind === "mix" ? null : { kind: i.kind, id: i.id }, { section });
}
const jump = (id, label) =>
	h("button", { type: "button", "data-nav": "", onclick: () => select({ kind: "node", id }) }, label ?? id);
/* What a route or stop judge reads. Topic and output are always sent; input and tool trace are opt-in. */
function contextPicks(holder) {
	const flip = part =>
		commit(
			T("act.judgeContext"),
			() => {
				const s = new Set(holder.state ?? []);
				s.has(part) ? s.delete(part) : s.add(part);
				holder.state = ["output", "input", "toolTrace"].filter(p => s.has(p));
				if (!holder.state.length) delete holder.state;
			},
			{ quiet: true },
		);
	return h(
		"div",
		{ class: "picks" },
		h("span", { class: "pick fixed", "data-always": T("pick.always") }, "topic"),
		h("span", { class: "pick fixed", "data-always": T("pick.always") }, "output"),
		["input", "toolTrace"].map(p =>
			h(
				"button",
				{
					class: "pick",
					type: "button",
					"aria-pressed": String(!!holder.state?.includes(p)),
					onclick: () => flip(p),
				},
				partToken(p),
			),
		),
	);
}
function showField(obj, what, options) {
	return h(
		"div",
		{ "data-sec": "show" },
		fld(
			T("show.label"),
			seg(options, obj.show ?? "", v =>
				commit(
					T("act.visibility"),
					() => {
						v ? (obj.show = v) : delete obj.show;
					},
					{ quiet: true },
				),
			),
			{ hint: [what, " ", T("show.note")] },
		),
	);
}
function idInput(obj, isEdge) {
	const el = liveTidy(
		h("input", {
			value: isEdge ? (obj.id ?? "") : obj.id,
			placeholder: isEdge ? eid(obj) : null,
			"aria-label": T("id.aria"),
			"data-field": "id",
			autocomplete: "off",
			spellcheck: "false",
		}),
	);
	const reset = () => {
		el.value = isEdge ? (obj.id ?? "") : obj.id;
	};
	el.addEventListener("keydown", ev => {
		if (ev.key === "Enter") el.blur();
		if (ev.key === "Escape") {
			reset();
			el.blur();
			ev.stopPropagation();
		}
	});
	el.addEventListener("change", () => {
		const v = el.value.trim();
		if (v === (isEdge ? (obj.id ?? "") : obj.id)) return;
		if (isEdge) {
			const why =
				v &&
				(idProblem(v, eid(obj), mix.edges.filter(x => x !== obj).map(eid)) ??
					(reservedEdge(v) && T("chk.edge.reserved", { id: v, why: reservedEdge(v) })));
			if (why) {
				toast(why, { bad: true });
				return reset();
			}
			return commit(v ? T("act.pathId") : T("act.pathIdCleared"), () => renameEdge(obj, v), { quiet: true });
		}
		const why = idProblem(v, obj.id);
		if (why) {
			toast(why, { bad: true });
			return reset();
		}
		let refs = 0;
		commit(
			T("act.rename"),
			() => {
				refs = renameNode(obj, v);
			},
			{ quiet: true },
		);
		renamed(refs, v);
	});
	return el;
}
/* The actions for whatever is selected: one row, always directly under the name. */
const actions = (...buttons) => h("div", { class: "pacts" }, buttons);
const act = (ic, label, run, o = {}) =>
	h(
		"button",
		{
			class: cls("btn small", o.danger && "danger"),
			type: "button",
			title: o.title,
			"data-nav": o.nav ? "" : null,
			onclick: run,
		},
		icon(ic),
		label,
	);

/* ═══════════════════════════ THE MIXTURE ═══════════════════════════ */
function storyLines() {
	const lines = [],
		order = [],
		seen = new Set();
	if (node(mix.entry)) {
		seen.add(mix.entry);
		order.push(mix.entry); // breadth first, so the story reads in the order a run can reach things
		for (let i = 0; i < order.length; i++)
			for (const e of outs(order[i]))
				for (const t of targets(e))
					if (!seen.has(t) && node(t)) {
						seen.add(t);
						order.push(t);
					}
		lines.push({ io: true, id: mix.entry, body: TX("story.enter", { id: mix.entry }) });
	}
	for (const id of order) {
		const n = node(id),
			body = [];
		if (!isModel(n)) {
			lines.push({ id, body: TX("story.verdict", { id, kind: verdictWord(n) }) });
			continue;
		}
		const livePaths = liveOuts(id),
			locked = outs(id).filter(isFan),
			capOf = e => (cap(e) !== undefined ? T("story.cap", { n: cap(e) }) : "");
		body.push(TX("story.answers", { id }));
		if (n.terminate) body.push(" ", TX("story.stop", { text: n.terminate.instructions || "…" }));
		if (locked.length) body.push(" ", T("story.fanout", { ids: locked[0].to.join(" + ") }));
		let sub = null;
		if (!livePaths.length && !locked.length) body.push(" ", n.terminate ? T("story.finalElse") : T("story.final"));
		else if (livePaths.length === 1)
			body.push(
				" ",
				n.terminate
					? TX("story.else", { to: livePaths[0].to, cap: capOf(livePaths[0]) })
					: TX("story.then", { to: livePaths[0].to, cap: capOf(livePaths[0]) }),
			);
		else if (livePaths.length > 1) {
			body.push(" ", TX("story.judge"));
			sub = h(
				"ul",
				{},
				livePaths.map(e =>
					h("li", {}, TX("story.branch", { when: e.when?.trim() || T("story.noWhen"), to: e.to, cap: capOf(e) })),
				),
			);
		}
		lines.push({ id, body, sub });
	}
	const hops = mix.limits?.maxHops ?? D().maxHops,
		actn = onLimit(),
		lt = limitTarget();
	lines.push({
		lim: true,
		body:
			actn === "judge" && lt
				? TX("story.limit.judge", { n: hops, id: lt.id })
				: actn === "stop"
					? T("story.limit.stop", { n: hops })
					: T("story.limit.pause", { n: hops }),
	});
	return lines;
}
function limitsSection() {
	const L = mix.limits ?? {},
		models = mix.members.filter(isModel),
		d = D(),
		actn = onLimit();
	const num = (key, label, def, unit, hint) =>
		fld(
			label,
			text(L, key, {
				number: true,
				label,
				placeholder: T("limits.default", { v: def }),
				k: "limit-" + key,
				set: v => setLimit(key, v),
			}),
			{ aside: unit, hint },
		);
	return sec(
		T("limits.title"),
		{ id: "limits", aside: T("limits.aside") },
		h(
			"div",
			{ class: "row2" },
			num("maxHops", T("limits.hops"), d.maxHops, T("limits.hops.unit")),
			num("wallClockMinutes", T("limits.clock"), d.wallClockMinutes, T("limits.clock.unit")),
		),
		num(
			"budgetUsd",
			T("limits.budget"),
			d.budgetUsd > 0 ? d.budgetUsd : T("limits.off"),
			"USD",
			T("limits.budget.hint"),
		),
		fld(
			T("limits.onLimit"),
			seg(
				[
					["stop", T("limits.stop")],
					["pause", T("limits.pause")],
					["judge", T("limits.judge")],
				],
				actn,
				v =>
					commit(
						T("act.onLimit", { v }),
						() => {
							setLimit("onLimit", v === d.onLimit && v !== "judge" ? undefined : v);
							if (v === "judge" && !isModel(node(mix.limits?.limitTarget)))
								setLimit("limitTarget", (models.find(n => !outs(n.id).length) ?? models.at(-1))?.id);
						},
						{ quiet: true },
					),
			),
			{ hint: { stop: T("limits.stop.hint"), pause: T("limits.pause.hint"), judge: T("limits.judge.hint") }[actn] },
		),
		actn === "judge" &&
			fld(
				T("limits.target"),
				choose([["", T("limits.target.pick"), true], ...models.map(n => [n.id, n.id])], L.limitTarget ?? "", v =>
					commit(T("act.limitAnswer", { id: v }), () => setLimit("limitTarget", v), { quiet: true }),
				),
				{ hint: T("limits.target.hint") },
			),
		h(
			"p",
			{ class: "hint", style: { marginTop: "10px" } },
			TX("limits.hard", {
				hops: d.hardMaxHops,
				budget: d.hardBudgetUsd > 0 ? "$" + d.hardBudgetUsd : T("limits.hard.none"),
			}),
		),
	);
}
function usesOf(kind, name) {
	const n =
		kind === "roles"
			? mix.members.filter(x => isModel(x) && x.systemPrompt === undefined && x.role === name).length
			: mix.edges.filter(e => envName(e) === name && isModel(node(e.to))).length +
				mix.members.filter(x => !isModel(x) && (x.render ?? "verdict") === name).length;
	return n ? T("preset.used", { n }) : T("preset.unused");
}
const scopeTag = scope =>
	h(
		"span",
		{ class: cls("tag", scope === "mixture" && "local") },
		scope === "mixture"
			? T("preset.scope.mixture")
			: scope === "file"
				? T("preset.scope.file")
				: T("preset.scope.bundled"),
	);
function presetsSection() {
	const list = kind =>
		h(
			"div",
			{ class: "plist" },
			presetNames(kind).map(p =>
				h(
					"button",
					{ class: "preset", type: "button", "data-nav": "", onclick: () => openPreset(kind, p.name) },
					h("b", {}, p.name),
					scopeTag(p.scope),
					h("small", {}, usesOf(kind, p.name)),
				),
			),
			h(
				"button",
				{
					class: "btn small ghost",
					type: "button",
					style: { justifySelf: "start" },
					onclick: () => newPreset(kind),
				},
				icon("plus", 12),
				kind === "roles" ? T("preset.newRole") : T("preset.newEnvelope"),
			),
		);
	return sec(
		T("preset.title"),
		{ id: "presets", aside: T("preset.aside") },
		h("p", { class: "hint" }, TX("preset.roles")),
		list("roles"),
		h("p", { class: "hint", style: { marginTop: "12px" } }, TX("preset.envelopes")),
		list("envelopes"),
	);
}
function newPreset(kind) {
	if (!guard()) return;
	const name = freeId(kind === "roles" ? "role-" : "envelope-", new Set(presetNames(kind).map(p => p.name)));
	commit(
		T("act.newPreset"),
		() => {
			(mix[kind] ??= {})[name] = kind === "roles" ? "" : "{{> moa-parts}}";
		},
		{ quiet: true },
	);
	openPreset(kind, name);
}
/* Records keep their order when a key is renamed. */
const rekey = (record, from, to) =>
	Object.fromEntries(Object.entries(record).map(([k, v]) => [k === from ? to : k, v]));
function openPreset(kind, name) {
	const found = presetText(kind, name);
	if (!found) return;
	const owner = found.scope === "mixture" ? mix : found.scope === "file" ? doc : null,
		editable = !!owner && !readOnly();
	const copy = () => {
		if (!guard()) return;
		const to = freeId(name + "-", new Set(presetNames(kind).map(p => p.name)));
		commit(
			T("act.copyPreset"),
			() => {
				(mix[kind] ??= {})[to] = found.text;
			},
			{ quiet: true },
		);
		openPreset(kind, to);
	};
	const nameIn = editable
		? h("input", { class: "in mono", value: name, spellcheck: "false", autocomplete: "off" })
		: null;
	/* Deleting text that something reads is said before it happens, like every other delete with consequences. */
	const remove = () => {
		const users = (owner === doc ? doc.mixtures : [mix]).flatMap(m => {
			if (owner === doc && own(m[kind], name)) return [];
			const who =
				kind === "roles"
					? m.members
							.filter(n => n.kind !== "verdict" && n.systemPrompt === undefined && n.role === name)
							.map(n => n.id)
					: [
							...m.edges
								.filter(e => e.envelope === name || (e.envelope === undefined && name === "handoff"))
								.map(e => `${e.from} → ${[e.to].flat().join(" + ")}`),
							...m.members.filter(n => n.kind === "verdict" && (n.render ?? "verdict") === name).map(n => n.id),
						];
			return who.length ? [[m.name, who]] : [];
		});
		const go = () => {
			closeSheet();
			commit(T("act.deletePreset", { name }), () => {
				delete owner[kind][name];
				if (!Object.keys(owner[kind]).length) delete owner[kind];
			});
		};
		if (!users.length) return go();
		const fallback = own(boot.bundled[kind], name) || (owner === mix && own(doc[kind], name));
		openSheet({
			title: T("preset.delete.title", { name }),
			sub: fallback
				? T("preset.delete.sub.fallback", {
						name,
						where: owner === mix && own(doc[kind], name) ? T("preset.delete.file") : T("preset.delete.builtin"),
					})
				: T("preset.delete.sub"),
			body: h(
				"ul",
				{ class: "impact" },
				users.map(([m, who]) =>
					h("li", {}, icon(fallback ? "info" : "warn"), h("span", {}, h("b", {}, m), ": ", who.join(", "))),
				),
			),
			note: T("delete.note"),
			onClose: () => openPreset(kind, name),
			primary: { label: T("common.delete"), danger: true, run: go },
		});
	};
	nameIn?.addEventListener("change", () => {
		const v = nameIn.value.trim();
		if (!v || v === "__proto__" || (v !== name && own(owner[kind], v))) {
			toast(!v ? T("preset.name.empty") : T("preset.name.taken", { name: v }), { bad: true });
			nameIn.value = name;
			return;
		}
		if (v === name) return;
		commit(
			T("act.renamePreset"),
			() => {
				owner[kind] = rekey(owner[kind], name, v);
				const scopeMixes = owner === doc ? doc.mixtures : [mix];
				for (const m of scopeMixes) {
					if (owner === doc && own(m[kind], name)) continue; // that mixture has its own preset of the old name
					if (kind === "roles") {
						for (const n of m.members) if (n.role === name) n.role = v;
					} else {
						for (const e of m.edges) if (e.envelope === name) e.envelope = v;
						for (const n of m.members) if (n.render === name) n.render = v;
					}
				}
			},
			{ quiet: true },
		);
		toast(T("preset.renamed"));
		openPreset(kind, v);
	});
	const area = grow(
		h("textarea", {
			class: "ta mono",
			value: found.text,
			rows: 6,
			disabled: !editable,
			spellcheck: "false",
			"data-autofocus": editable ? "" : null,
		}),
	);
	area.addEventListener("input", () =>
		typing("preset:" + kind + name, () => {
			owner[kind][name] = area.value;
		}),
	);
	const where =
		editable &&
		seg(
			[
				["mixture", T("preset.scope.mixture")],
				["file", T("preset.where.file")],
			],
			found.scope,
			v => {
				const dest = v === "file" ? doc : mix;
				if (own(dest[kind], name)) return toast(T("preset.name.taken", { name }), { bad: true });
				commit(
					T("act.movePreset"),
					() => {
						const value = owner[kind][name];
						delete owner[kind][name];
						if (!Object.keys(owner[kind]).length) delete owner[kind];
						(dest[kind] ??= {})[name] = value;
					},
					{ quiet: true },
				);
				openPreset(kind, name);
			},
		);
	openSheet({
		width: 700,
		title: [kind === "roles" ? T("preset.role") : T("preset.envelope"), " · ", h("span", { class: "mono" }, name)],
		sub: [
			found.scope === "bundled"
				? T("preset.sub.bundled")
				: found.scope === "file"
					? T("preset.sub.file")
					: T("preset.sub.mixture"),
			" ",
			usesOf(kind, name),
			".",
		],
		body: [
			editable && h("div", { class: "row2" }, fld(T("preset.name"), nameIn), fld(T("preset.where"), where)),
			fld(
				kind === "roles" ? T("preset.text.role") : T("preset.text.envelope"),
				[area, editable && kind === "envelopes" && insertChips(area, null)],
				{ hint: kind === "envelopes" ? T("preset.hint.envelope") : T("preset.hint.role") },
			),
		],
		note: editable ? T("preset.note") : null,
		cancel: null,
		extra: [
			editable && h("button", { class: "btn danger", type: "button", onclick: remove }, T("common.delete")),
			!readOnly() &&
				h(
					"button",
					{ class: "btn", type: "button", onclick: copy },
					found.scope === "bundled" ? T("preset.copy") : T("common.duplicate"),
				),
		],
		primary: {
			label: T("common.done"),
			run: () => {
				closeSheet();
				render();
			},
		},
	});
}
/* Where this mixture stands with the harness: a separate fact from whether the draft is saved. */
function rosterLine() {
	const state = mixState(mix, cur.sid),
		row = mix.$o && srcOf(mix.$o.sid)?.mixtures.find(x => x.name === mix.$o.name),
		other = row?.shadowedBy && srcOf(row.shadowedBy);
	const tail = state ? " " + T("roster.stale") : "";
	if (!row) return { cls: "", body: T("roster.new") };
	if (row.status === "shadowed")
		return { cls: "w", body: TX("roster.shadowed", { path: other?.displayPath ?? "?", name: row.name }) };
	if (row.status === "invalid") return { cls: "w", body: T("roster.notRunnable") };
	if (row.status === "registered") return { cls: "ok", body: [TX("roster.registered", { name: row.name }), tail] };
	if (row.status === "unregistered") return { cls: "w", body: T("roster.unregistered") };
	return { cls: "", body: [T("roster.unknown"), tail] };
}
function panelMixture() {
	const name = liveTidy(
		h("input", {
			value: mix.name,
			"aria-label": T("mix.name.aria"),
			"data-field": "name",
			autocomplete: "off",
			spellcheck: "false",
		}),
		true,
	);
	name.addEventListener("keydown", ev => {
		if (ev.key === "Enter") name.blur();
		if (ev.key === "Escape") {
			name.value = mix.name;
			name.blur();
			ev.stopPropagation();
		}
	});
	name.addEventListener("change", () => {
		const why = renameMixture(mix, name.value.trim());
		if (why) {
			toast(why, { bad: true });
			name.value = mix.name;
		}
	});
	const roster = rosterLine(),
		m = mix;
	return [
		h(
			"div",
			{ class: "phead" },
			h("div", { class: "eyebrow" }, T("mix.eyebrow")),
			h("div", { class: "ptitle" }, name),
			text(mix, "description", { area: true, placeholder: T("mix.description") }).also(
				el => (el.className = "quiet-in"),
			),
			!readOnly() &&
				actions(
					act("swap", T("mix.move"), () => openMove(m)),
					act("dup", T("common.duplicate"), () => duplicateMixture(m)),
					act("trash", T("common.delete"), () => deleteMixture(m), { danger: true }),
				),
		),
		h("div", { class: cls("says", roster.cls) }, roster.body),
		live("div", {}, () => issueList(issuesFor("mix"))),
		mix.members.length > 0 &&
			sec(
				T("story.title"),
				{ id: "story", aside: T("story.aside") },
				live("ol", { class: "story" }, () =>
					storyLines().map(l =>
						h(
							"li",
							{
								class: cls(l.io && "io", l.lim && "lim"),
								onclick: () =>
									l.lim ? select(null, { section: "limits" }) : select({ kind: "node", id: l.id }),
							},
							h("span", {}, l.body, l.sub),
						),
					),
				),
			),
		mix.members.length > 0 &&
			sec(
				T("members.title"),
				{
					id: "members",
					n: `${mix.members.length} / ${boot.limits.members}`,
					aside: T("members.paths", { n: mix.edges.length, max: boot.limits.edges }),
				},
				h(
					"div",
					{ class: "plist" },
					mix.members.map((n, i) =>
						h(
							"div",
							{ class: "member" },
							h(
								"button",
								{
									class: "preset",
									type: "button",
									"data-nav": "",
									onclick: () => select({ kind: "node", id: n.id }),
								},
								h("span", { class: cls("kind", !isModel(n) && "v") }, icon(kindIcon(n), 11)),
								h("b", {}, n.id),
								n.id === mix.entry && h("span", { class: "tag local" }, T("members.start")),
								limitTarget() === n && h("span", { class: "tag" }, T("members.onLimit")),
								h("small", {}, isModel(n) ? n.model : T("card.verdict")),
							),
							h(
								"button",
								{
									class: "icon-btn",
									type: "button",
									title: T("members.up"),
									disabled: i === 0,
									onclick: () =>
										commit(
											T("act.reorderMembers"),
											() => {
												[mix.members[i - 1], mix.members[i]] = [mix.members[i], mix.members[i - 1]];
											},
											{ quiet: true },
										),
								},
								icon("up", 12),
							),
							h(
								"button",
								{
									class: "icon-btn",
									type: "button",
									title: T("members.down"),
									disabled: i === mix.members.length - 1,
									onclick: () =>
										commit(
											T("act.reorderMembers"),
											() => {
												[mix.members[i + 1], mix.members[i]] = [mix.members[i], mix.members[i + 1]];
											},
											{ quiet: true },
										),
								},
								icon("down", 12),
							),
						),
					),
				),
				h("p", { class: "hint", style: { marginTop: "8px" } }, T("members.hint")),
			),
		limitsSection(),
		presetsSection(),
		sec(
			T("judges.title"),
			{ aside: T("judges.aside") },
			boot.judgePlan?.length
				? h(
						"div",
						{ class: "chain" },
						boot.judgePlan.map((j, i) =>
							h(
								"div",
								{ class: i ? "" : "win" },
								h("span", {}, j.model),
								h("small", {}, i ? T("judges.next") : T("judges.first")),
							),
						),
						boot.summaryModel &&
							h("div", {}, h("span", {}, boot.summaryModel), h("small", {}, T("judges.summary"))),
					)
				: h("p", { class: "hint" }, T("judges.unknown")),
			h("p", { class: "hint", style: { marginTop: "8px" } }, T("judges.hint")),
		),
		sec(
			T("gated.title"),
			null,
			mix.steering
				? gated(
						"M3",
						T("gated.steering.set", { id: mix.steering.target }),
						T("gated.steering.setWhy"),
						h(
							"button",
							{
								class: "btn small",
								type: "button",
								onclick: () =>
									commit(T("act.steeringOff"), () => {
										delete mix.steering;
									}),
							},
							T("common.remove"),
						),
					)
				: gated("M3", T("gated.steering"), T("gated.steering.why")),
			mix.serve === true
				? gated(
						"M6",
						T("gated.serve.set"),
						T("gated.serve.setWhy"),
						h(
							"button",
							{
								class: "btn small",
								type: "button",
								onclick: () =>
									commit(T("act.serveOff"), () => {
										delete mix.serve;
									}),
							},
							T("gated.serve.off"),
						),
					)
				: gated("M6", T("gated.serve"), T("gated.serve.why")),
		),
	];
}

/* ═══════════════════════════ A MODEL ═══════════════════════════ */
function modelPicker(n) {
	const res = resolveModel(n),
		[base, effort] = splitEffort(n.model ?? ""),
		entry = boot.models.find(m => m.selector === base);
	const set = (b, e) =>
		commit(
			T("act.model"),
			() => {
				n.model = b + (e ? ":" + e : "");
			},
			{ quiet: true },
		);
	const btn = h(
		"button",
		{
			class: "in mono",
			type: "button",
			"data-field": "model",
			style: { textAlign: "left", display: "flex", alignItems: "center", gap: "8px", minHeight: "36px" },
			"aria-haspopup": "listbox",
		},
		h(
			"span",
			{ style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
			base || T("model.pick"),
		),
		icon("chev", 12),
	);
	btn.onclick = () => {
		togglePop(
			btn,
			() => {
				const input = h("input", {
						class: "in mono",
						placeholder: T("model.search"),
						spellcheck: "false",
						autocomplete: "off",
					}),
					list = h("div", { class: "scroll" });
				const fill = () => {
					const qy = input.value.trim().toLowerCase();
					const hits = boot.models
						.filter(
							c => !qy || c.selector.toLowerCase().includes(qy) || (c.resolved ?? "").toLowerCase().includes(qy),
						)
						.sort((a, b) => (a.role && !a.resolved) - (b.role && !b.resolved));
					list.replaceChildren(
						...hits
							.slice(0, 80)
							.map(c =>
								mi(
									null,
									c.selector,
									() => set(c.selector, c.efforts && !c.efforts.includes(effort) ? "" : effort),
									{
										hint: c.role ? (c.resolved ? "→ " + c.resolved : T("model.role.unset")) : null,
										mono: true,
										on: c.selector === base,
									},
								),
							),
						...(qy && !hits.some(c => c.selector.toLowerCase() === qy)
							? [
									mi("edit", T("model.use", { text: input.value.trim() }), () => set(input.value.trim(), ""), {
										hint: T("model.use.hint"),
									}),
								]
							: []),
						...(hits.length > 80
							? [h("div", { class: "pad hint" }, T("model.more", { n: hits.length - 80 }))]
							: []),
					);
				};
				input.addEventListener("input", fill);
				input.addEventListener("keydown", ev => {
					if (ev.key === "Enter") list.querySelector(".mi")?.click();
				});
				fill();
				setTimeout(() => input.focus());
				return [input, list];
			},
			{ width: 340 },
		);
	};
	/* A role alias takes the effort levels of the model it stands for; a level already written in the file is always offered. */
	const known = entry?.efforts ??
		boot.models.find(m => m.selector === entry?.resolved)?.efforts ?? ["low", "medium", "high"];
	const efforts = EFFORTS.filter(e => e !== "auto" && (known.includes(e) || e === effort));
	return [
		fld(T("model.label"), btn, {
			hint:
				res.state === "ok"
					? res.effort
						? TX("model.resolves.effort", { model: res.res, effort: res.effort })
						: TX("model.resolves", { model: res.res })
					: res.state === "unset"
						? T("model.unset", { selector: base })
						: res.state === "unknown"
							? T("model.unknown")
							: T("model.required"),
		}),
		efforts.length > 0 &&
			fld(
				T("model.effort"),
				seg(
					[
						[
							"",
							entry?.effort ? T("model.effort.defaultIs", { effort: entry.effort }) : T("model.effort.default"),
						],
						...efforts.map(e => [e, e]),
					],
					effort === "auto" ? "" : effort,
					v => set(base, v),
				),
				{ hint: entry?.effort ? T("model.effort.hint.role", { selector: base }) : T("model.effort.hint") },
			),
	];
}
function promptSection(n) {
	const mode =
			n.systemPrompt !== undefined
				? n.systemPrompt === "" && n.$empty
					? "empty"
					: "inline"
				: n.role !== undefined
					? "preset"
					: "inline",
		roles = presetNames("roles"),
		found = presetText("roles", n.role);
	const pick = v =>
		commit(
			T("act.promptSource"),
			() => {
				if (v === "inline") {
					n.systemPrompt = n.$prompt ?? "";
					delete n.$empty;
					if (!n.$hadBoth) delete n.role;
				}
				if (v === "empty") {
					if (n.systemPrompt) n.$prompt = n.systemPrompt;
					n.systemPrompt = "";
					n.$empty = true;
					delete n.role;
				}
				if (v === "preset") {
					if (n.systemPrompt) n.$prompt = n.systemPrompt;
					delete n.systemPrompt;
					delete n.$empty;
					n.role ??= roles[0]?.name;
				}
			},
			{ quiet: true },
		);
	return sec(
		T("prompt.title"),
		{ id: "prompt" },
		seg(
			[
				["inline", T("prompt.inline")],
				["preset", T("prompt.role")],
				["empty", T("prompt.empty")],
			],
			mode,
			pick,
		),
		mode === "inline" &&
			fld(
				null,
				text(n, "systemPrompt", {
					area: true,
					rows: 3,
					keep: true,
					placeholder: T("prompt.placeholder"),
					field: "prompt",
				}),
			),
		mode === "preset" && [
			fld(
				null,
				h(
					"div",
					{ style: { display: "flex", gap: "6px" } },
					choose(
						[
							...roles.map(r => [r.name, r.name]),
							...(n.role && !found ? [[n.role, T("prompt.role.missing", { name: n.role })]] : []),
						],
						n.role,
						v =>
							commit(
								T("act.role"),
								() => {
									n.role = v;
								},
								{ quiet: true },
							),
						{ "data-field": "prompt" },
					),
					h(
						"button",
						{
							class: "btn",
							type: "button",
							"data-nav": "",
							title: T("prompt.role.open"),
							disabled: !found,
							onclick: () => openPreset("roles", n.role),
						},
						icon("edit"),
					),
				),
			),
			found && h("div", { class: "tpl" }, found.text || T("prompt.role.blank")),
		],
		mode === "empty" && h("p", { class: "hint", style: { marginTop: "8px" } }, T("prompt.empty.hint")),
		fld(
			T("prompt.inherit"),
			seg(
				[
					["", T("prompt.inherit.default")],
					["true", T("prompt.inherit.yes")],
					["false", T("prompt.inherit.no")],
				],
				n.inherit === undefined ? "" : String(n.inherit),
				v =>
					commit(
						T("act.inherit"),
						() => {
							v === "" ? delete n.inherit : (n.inherit = v === "true");
						},
						{ quiet: true },
					),
			),
			{ hint: T("prompt.inherit.hint") },
		),
	);
}
const ynRows = (holder, k) => {
	const c = holder.criteria ?? {};
	const row = (key, word, ph) => [
		h("b", {}, word),
		text(c, key, {
			area: true,
			placeholder: ph,
			k: k + key,
			set: v => {
				const next = { ...holder.criteria };
				v === undefined ? delete next[key] : (next[key] = v);
				Object.keys(next).length ? (holder.criteria = next) : delete holder.criteria;
			},
		}),
	];
	return h(
		"div",
		{ class: "yn" },
		row("true", T("verdict.yes"), T("yn.yes")),
		row("false", T("verdict.no"), T("yn.no")),
	);
};
function stopCard(n) {
	const t = n.terminate;
	if (!t)
		return h(
			"div",
			{ class: "card off", "data-sec": "stop" },
			h("header", {}, h("span", { class: "n" }, "1"), T("stop.title"), h("small", {}, T("stop.off"))),
			h("p", { class: "hint", style: { margin: "6px 0 8px" } }, T("stop.offHint")),
			h(
				"button",
				{
					class: "btn small",
					type: "button",
					onclick: () => {
						commit(
							T("act.addStop"),
							() => {
								n.terminate = n.$terminate ?? { instructions: "" };
								delete n.$terminate;
							},
							{ quiet: true },
						);
						focusField("stop");
					},
				},
				icon("plus", 12),
				n.$terminate ? T("stop.restore") : T("stop.add"),
			),
		);
	return h(
		"div",
		{ class: "card j", "data-sec": "stop" },
		h(
			"header",
			{},
			h("span", { class: "n" }, "1"),
			T("stop.title"),
			h(
				"button",
				{
					class: "btn small",
					type: "button",
					style: { marginLeft: "auto" },
					title: T("stop.remove"),
					onclick: () =>
						commit(T("act.removeStop"), () => {
							n.$terminate = n.terminate;
							delete n.terminate;
						}),
				},
				T("stop.turnOff"),
			),
		),
		fld(
			T("stop.question"),
			text(t, "instructions", {
				area: true,
				rows: 2,
				keep: true,
				placeholder: T("stop.placeholder"),
				field: "stop",
			}),
		),
		fld(T("yn.label"), ynRows(t, "stop")),
		fld(
			T("stop.threshold"),
			range(t, "threshold", D().threshold, "threshold", {
				label: T("stop.threshold"),
				explain: v => T("stop.threshold.explain", { v: v.toFixed(2) }),
			}),
		),
		fld(T("judge.reads"), contextPicks(t)),
	);
}
function pathsCard(n) {
	const livePaths = liveOuts(n.id),
		locked = outs(n.id).filter(isFan),
		r = n.route,
		fb = r?.fallback;
	const move = (e, d) =>
		commit(
			T("act.reorderPaths"),
			() => {
				const sibs = outs(n.id),
					other = sibs[sibs.indexOf(e) + d],
					a = mix.edges.indexOf(e),
					b = mix.edges.indexOf(other);
				[mix.edges[a], mix.edges[b]] = [mix.edges[b], mix.edges[a]];
			},
			{ quiet: true },
		);
	const pathRow = (e, i) =>
		h(
			"div",
			{ class: "path" },
			h(
				"span",
				{ class: "meta" },
				"→",
				jump(e.to),
				cap(e) !== undefined && ` · ≤${cap(e)}×`,
				fb === eid(e) && h("span", { class: "tag judge" }, T("card.unsure")),
			),
			h(
				"span",
				{ class: "go" },
				h(
					"button",
					{
						class: "icon-btn",
						type: "button",
						title: T("paths.up"),
						disabled: i === 0,
						onclick: () => move(e, -1),
					},
					icon("up", 12),
				),
				h(
					"button",
					{
						class: "icon-btn",
						type: "button",
						title: T("paths.down"),
						disabled: i === livePaths.length - 1,
						onclick: () => move(e, 1),
					},
					icon("down", 12),
				),
				h(
					"button",
					{
						class: "icon-btn",
						type: "button",
						"data-nav": "",
						title: T("paths.open"),
						onclick: () => select({ kind: "edge", id: e.$k }),
					},
					icon("right", 12),
				),
			),
			livePaths.length >= 2
				? text(e, "when", { area: true, placeholder: T("paths.when"), k: "when-" + e.$k })
				: h(
						"span",
						{ class: "hint", style: { gridColumn: "1/-1" } },
						e.when ? T("paths.onlyWhen", { when: e.when }) : T("paths.only"),
					),
		);
	const add = h(
		"button",
		{ class: "btn small", type: "button", onclick: () => startConnect({ from: n.id }) },
		icon("plus", 12),
		T("paths.add"),
	);
	if (!livePaths.length && !locked.length)
		return h(
			"div",
			{ class: "card off", "data-sec": "paths" },
			h("header", {}, h("span", { class: "n" }, "2"), T("paths.title"), h("small", {}, T("paths.nowhere"))),
			h("p", { class: "hint", style: { margin: "6px 0 8px" } }, TX("paths.none")),
			add,
		);
	const many = livePaths.length >= 2;
	return h(
		"div",
		{ class: cls("card", many && "j"), "data-sec": "paths" },
		h(
			"header",
			{},
			h("span", { class: "n" }, "2"),
			many ? T("paths.judge") : T("paths.title"),
			h("small", {}, many ? T("paths.oneOf", { n: livePaths.length }) : T("paths.always")),
		),
		many && [
			fld(
				T("paths.instructions"),
				text(r ?? {}, "instructions", {
					area: true,
					rows: 2,
					keep: true,
					placeholder: T("paths.instructions.placeholder"),
					field: "route",
					set: v => {
						n.route = { ...n.route, instructions: v ?? "" };
					},
				}),
			),
			h("p", { class: "hint", style: { marginTop: "8px" } }, T("paths.exclusive")),
		],
		h(
			"div",
			{ class: "paths" },
			livePaths.map(pathRow),
			locked.map(e =>
				h(
					"div",
					{ class: "gated", style: { marginTop: 0 } },
					icon("lock"),
					h(
						"span",
						{},
						h("b", {}, T("card.fanout", { ids: e.to.join(" + ") })),
						h("small", {}, T("paths.fanout")),
					),
					h(
						"button",
						{
							class: "btn small",
							type: "button",
							"data-nav": "",
							onclick: () => select({ kind: "edge", id: e.$k }),
						},
						T("common.open"),
					),
				),
			),
		),
		h("div", { style: { marginTop: "8px" } }, add),
		many &&
			r && [
				fld(
					T("paths.unsure"),
					choose(
						[
							["", T("paths.unsure.pause")],
							...livePaths.map(e => [
								eid(e),
								T("paths.unsure.follow", { to: e.to }) + (e.when ? " · " + e.when.slice(0, 40) : ""),
							]),
						],
						fb && fb !== "pause" ? fb : "",
						v =>
							commit(
								T("act.unsure"),
								() => {
									v ? (n.route.fallback = v) : delete n.route.fallback;
								},
								{ quiet: true },
							),
					),
				),
				fld(
					T("paths.confidence"),
					range(n.route, "minConfidence", D().minConfidence, "confidence", {
						label: T("paths.confidence"),
						explain: v =>
							fb && fb !== "pause"
								? T("paths.confidence.follow", { v: v.toFixed(2) })
								: T("paths.confidence.pause", { v: v.toFixed(2) }),
					}),
				),
				fld(T("judge.reads"), contextPicks(n.route)),
			],
		!many &&
			r &&
			h(
				"p",
				{ class: "hint", style: { marginTop: "8px" } },
				T("paths.bypassed"),
				" ",
				h(
					"button",
					{
						class: "btn small",
						type: "button",
						onclick: () =>
							commit(T("act.removeRoute"), () => {
								delete n.route;
							}),
					},
					T("paths.bypassed.remove"),
				),
			),
	);
}
function toolsRow(n) {
	const on = toolsOn(n),
		shown =
			n.tools === undefined
				? T("tools.unset")
				: Array.isArray(n.tools)
					? "[" + n.tools.join(", ") + "]"
					: String(n.tools);
	return h(
		"div",
		{ "data-sec": "tools" },
		gated(
			"M3",
			on ? T("tools.on", { value: shown }) : T("tools.off"),
			on ? (n.tools === undefined ? T("tools.implicit") : T("tools.onWhy")) : T("tools.offWhy"),
			on
				? h(
						"button",
						{
							class: "btn small",
							type: "button",
							onclick: () =>
								commit(T("act.toolsOff"), () => {
									n.tools = false;
								}),
						},
						T("gated.serve.off"),
					)
				: null,
		),
	);
}
function panelModel(n) {
	const start = n.id === mix.entry,
		lt = limitTarget() === n,
		incoming = ins(n.id);
	return [
		h(
			"div",
			{ class: "phead" },
			h(
				"div",
				{ class: "eyebrow" },
				icon("spark", 11),
				T("model.eyebrow"),
				start && h("span", { class: "badge start" }, T("model.badge.start")),
				lt && h("span", { class: "badge onlimit" }, T("model.badge.limit")),
			),
			h("div", { class: "ptitle" }, idInput(n)),
			text(n, "description", { area: true, placeholder: T("model.description") }).also(
				el => (el.className = "quiet-in"),
			),
			actions(
				!start && act("flag", T("model.startHere"), () => setEntry(n)),
				act("hour", lt ? T("model.limitOff") : T("model.limitOn"), () => toggleLimitTarget(n)),
				act("dup", T("common.duplicate"), () => duplicateNode(n)),
				act("trash", T("common.delete"), () => deleteNodes([n.id]), { danger: true }),
			),
		),
		live("div", {}, () => issueList(issuesFor("node", n.id))),
		sec(T("model.who"), { id: "model" }, modelPicker(n)),
		promptSection(n),
		sec(T("after.title"), { id: "after", aside: T("after.aside") }, stopCard(n), pathsCard(n)),
		sec(
			T("incoming.title"),
			{ n: incoming.length },
			incoming.length
				? h(
						"div",
						{ class: "plist" },
						incoming.map(e =>
							h(
								"button",
								{
									class: "preset",
									type: "button",
									"data-nav": "",
									onclick: () => select({ kind: "edge", id: e.$k }),
								},
								h("b", {}, e.from),
								h("small", {}, partsText(e)),
							),
						),
					)
				: h("p", { class: "hint" }, start ? T("incoming.start") : lt ? T("incoming.limit") : T("incoming.none")),
		),
		sec(
			T("output.title"),
			null,
			fld(
				T("output.maxTokens"),
				text(n, "maxTokens", {
					number: true,
					label: T("output.maxTokens"),
					placeholder: T("output.maxTokens.default"),
					field: "maxTokens",
				}),
				{ aside: T("output.tokens") },
			),
			showField(n, T("show.model"), [
				["", T("show.default")],
				["always", T("show.always")],
				["final", T("show.final")],
				["never", T("show.never")],
			]),
		),
		sec(T("gated.title"), null, toolsRow(n)),
	];
}

/* ═══════════════════════════ A VERDICT ═══════════════════════════ */
function criteriaEditor(n) {
	const q = n.question;
	if (q.type === "noul") return h("div", { "data-sec": "criteria" }, fld(T("yn.label"), ynRows(q, "verdict")));
	const choice = q.type === "choice",
		list = choice ? choicesOf(n) : (q.criteria ??= []),
		done = () => {
			if (choice) writeChoices(n);
		};
	const edit = (label, fn) =>
		commit(
			label,
			() => {
				fn();
				done();
			},
			{ quiet: true },
		);
	const moves = i =>
		h(
			"span",
			{ class: "go" },
			h(
				"button",
				{
					class: "icon-btn",
					type: "button",
					title: T("paths.up"),
					disabled: i === 0,
					onclick: () =>
						edit(T("act.reordered"), () => {
							[list[i - 1], list[i]] = [list[i], list[i - 1]];
						}),
				},
				icon("up", 12),
			),
			h(
				"button",
				{
					class: "icon-btn",
					type: "button",
					title: T("paths.down"),
					disabled: i === list.length - 1,
					onclick: () =>
						edit(T("act.reordered"), () => {
							[list[i + 1], list[i]] = [list[i], list[i + 1]];
						}),
				},
				icon("down", 12),
			),
			h(
				"button",
				{
					class: "icon-btn",
					type: "button",
					title: list.length <= 2 ? T("criteria.min") : T("common.remove"),
					disabled: list.length <= 2,
					onclick: () =>
						edit(T("act.removed"), () => {
							list.splice(i, 1);
						}),
				},
				icon("x", 12),
			),
		);
	return h(
		"div",
		{ "data-sec": "criteria" },
		h(
			"div",
			{ class: "levels" },
			list.map((item, i) =>
				choice
					? h(
							"div",
							{ class: "level" },
							h("b", {}, icon("dot", 9)),
							h(
								"span",
								{ class: "two" },
								text(item, 0, {
									mono: true,
									keep: true,
									placeholder: T("criteria.label"),
									k: "cl" + i,
									set: v => {
										item[0] = v ?? "";
										done();
									},
								}),
								text(item, 1, {
									placeholder: T("criteria.rubric"),
									k: "cr" + i,
									set: v => {
										item[1] = v ?? "";
										done();
									},
								}),
							),
							moves(i),
						)
					: h(
							"div",
							{ class: "level" },
							h("b", {}, i),
							text(list, i, {
								keep: true,
								placeholder: i === 0 ? T("criteria.level0") : T("criteria.level"),
								k: "lv" + i,
							}),
							moves(i),
						),
			),
		),
		h(
			"button",
			{
				class: "btn small ghost",
				type: "button",
				style: { marginTop: "6px" },
				onclick: () =>
					edit(T("act.added"), () => {
						list.push(choice ? ["", ""] : "");
					}),
			},
			icon("plus", 12),
			choice ? T("criteria.addChoice") : T("criteria.addLevel"),
		),
		!choice && h("p", { class: "hint", style: { marginTop: "6px" } }, T("criteria.scoreHint")),
	);
}
function panelVerdict(n) {
	const incoming = ins(n.id),
		q = n.question,
		mode = n.state === undefined ? "all" : n.state.length ? "selected" : n.$selected ? "selected" : "topic";
	const setType = v =>
		commit(
			T("act.questionType"),
			() => {
				(n.$kept ??= {})[q.type] = { criteria: q.criteria, list: q.$list };
				delete q.$list; // switching type and back loses nothing
				const kept = n.$kept[v];
				q.type = v;
				q.criteria =
					kept?.criteria ??
					(v === "choice"
						? { approve: null, reject: null }
						: v === "score"
							? ["Unusable", "Needs work", "Good", "Excellent"]
							: undefined);
				if (kept?.list) q.$list = kept.list;
				if (q.criteria === undefined) delete q.criteria;
			},
			{ quiet: true },
		);
	const reads = part => mode === "all" || (mode === "selected" && n.state?.includes(part));
	const sample = name =>
		({
			"member.id": n.id,
			judge: boot.judgePlan?.[0]?.model ?? T("verdict.sample.judge"),
			judgeKind: "native",
			"question.instructions": q.instructions || undefined,
			"answer.noul": q.type === "noul" ? "0.86" : undefined,
			"answer.choice": q.type === "choice" ? choicesOf(n)[0]?.[0] || "approve" : undefined,
			"answer.score": q.type === "score" ? Math.max(0, (q.criteria?.length ?? 1) - 1) : undefined,
			confidence: q.type === "noul" ? undefined : "0.74",
		})[name];
	const local = presetNames("envelopes")
		.filter(p => p.scope !== "bundled")
		.map(p => p.name);
	return [
		h(
			"div",
			{ class: "phead" },
			h(
				"div",
				{ class: "eyebrow" },
				icon("scale", 11),
				h("span", { class: "judge" }, T("verdict.eyebrow")),
				h(
					"span",
					{ class: "badge", style: { color: "var(--flow)", border: "1px solid var(--flow)" } },
					T("verdict.badge"),
				),
			),
			h("div", { class: "ptitle" }, idInput(n)),
			text(n, "description", { area: true, placeholder: T("verdict.description") }).also(
				el => (el.className = "quiet-in"),
			),
			actions(
				act("dup", T("common.duplicate"), () => duplicateNode(n)),
				act("trash", T("common.delete"), () => deleteNodes([n.id]), { danger: true }),
			),
		),
		live("div", {}, () => issueList(issuesFor("node", n.id))),
		sec(
			T("verdict.question"),
			{ id: "question" },
			seg(
				[
					["noul", T("verdict.type.noul")],
					["choice", T("verdict.type.choice")],
					["score", T("verdict.type.score")],
				],
				q.type,
				setType,
			),
			fld(
				null,
				text(q, "instructions", {
					area: true,
					rows: 2,
					keep: true,
					placeholder: T("verdict.placeholder"),
					field: "question",
				}),
			),
			h("div", { style: { marginTop: "10px" } }, criteriaEditor(n)),
		),
		sec(
			T("verdict.reads"),
			{ id: "state" },
			seg(
				[
					["all", T("verdict.reads.all")],
					["selected", T("verdict.reads.some")],
					["topic", T("verdict.reads.topic")],
				],
				mode,
				v =>
					commit(
						T("act.verdictInput"),
						() => {
							delete n.$selected;
							if (v === "all") delete n.state;
							if (v === "topic") n.state = [];
							if (v === "selected") {
								n.state = n.state?.length ? n.state : ["output"];
								n.$selected = true;
							}
						},
						{ quiet: true },
					),
			),
			mode === "selected" &&
				h(
					"div",
					{ class: "picks", style: { marginTop: "8px" } },
					h("span", { class: "pick fixed", "data-always": T("pick.always") }, "topic"),
					PARTS.map(p =>
						h(
							"button",
							{
								class: "pick",
								type: "button",
								"aria-pressed": String(!!n.state?.includes(p)),
								onclick: () =>
									commit(
										T("act.verdictInput"),
										() => {
											const s = new Set(n.state);
											s.has(p) ? s.delete(p) : s.add(p);
											n.state = PARTS.filter(x => s.has(x));
											n.$selected = true;
										},
										{ quiet: true },
									),
							},
							partToken(p),
						),
					),
				),
			h(
				"p",
				{ class: "hint", style: { margin: "8px 0" } },
				{
					all: T("verdict.reads.all.hint"),
					selected: T("verdict.reads.some.hint"),
					topic: T("verdict.reads.topic.hint"),
				}[mode],
				" ",
				T("verdict.reads.direct"),
			),
			incoming.length
				? h(
						"div",
						{ class: "plist" },
						incoming.map(e =>
							h(
								"button",
								{
									class: "preset",
									type: "button",
									"data-nav": "",
									onclick: () => select({ kind: "edge", id: e.$k }),
								},
								h("b", {}, e.from),
								h(
									"small",
									{},
									partsOf(e).filter(reads).map(partToken).join(" + ") || T("verdict.reads.requestOnly"),
									partsOf(e).some(p => !reads(p)) &&
										h(
											"s",
											{ style: { marginLeft: "6px", opacity: 0.6 } },
											partsOf(e)
												.filter(p => !reads(p))
												.map(partToken)
												.join(" + "),
										),
								),
							),
						),
					)
				: h("p", { class: "hint" }, T("verdict.incoming.none")),
		),
		sec(
			T("verdict.render"),
			{ id: "render" },
			choose(
				[
					["", T("verdict.render.builtin")],
					...local.map(name => [name, name]),
					...(n.render !== undefined && !local.includes(n.render)
						? [[n.render, T("prompt.role.missing", { name: n.render })]]
						: []),
				],
				n.render ?? "",
				v =>
					commit(
						T("act.answerTemplate"),
						() => {
							v ? (n.render = v) : delete n.render;
						},
						{ quiet: true },
					),
				{ "data-field": "render" },
			),
			live("div", {}, () => renderTemplate(presetText("envelopes", n.render ?? "verdict")?.text ?? "", sample)),
			h("p", { class: "hint", style: { marginTop: "6px" } }, T("verdict.render.hint")),
		),
		sec(
			T("output.title"),
			null,
			showField(n, T("show.verdict"), [
				["", T("show.default")],
				["always", T("show.always")],
				["final", T("show.final")],
				["never", T("show.never")],
			]),
		),
	];
}

/* ═══════════════════════════ A PATH ═══════════════════════════ */
/* Renders a template the way the engine would, with chips standing in for text that only exists during a run.
   Handles the constructs the bundled templates use: {{name}}, {{#if name}}…{{/if}} and the {{> moa-parts}} partial. */
function renderTemplate(source, lookupVar) {
	let src = source.replace(/\{\{>\s*moa-parts\s*\}\}/g, boot.bundled.partial ?? "");
	const block = /\{\{#if\s+([\w.]+)\s*\}\}((?:(?!\{\{#if)[\s\S])*?)\{\{\/if\}\}/;
	for (let m, tries = 0; (m = block.exec(src)) && tries < 200; tries++) {
		const v = lookupVar(m[1]),
			[yes, no = ""] = m[2].split(/\{\{else\}\}/);
		src = src.slice(0, m.index) + (v != null && v !== "" ? yes : no) + src.slice(m.index + m[0].length);
	}
	src = src.replace(/\n{3,}/g, "\n\n").trim();
	const out = h("div", { class: "tpl read" }),
		re = /\{\{\s*([\w.]+)\s*\}\}/g;
	let at = 0,
		m;
	while ((m = re.exec(src))) {
		out.append(src.slice(at, m.index));
		const v = lookupVar(m[1]);
		out.append(
			v == null
				? h("span", { class: "x", title: T("tpl.empty") }, m[0])
				: v.chip
					? h("span", { class: "stand", title: T("tpl.runtime") }, v.chip)
					: h("span", { class: "v" }, String(v)),
		);
		at = m.index + m[0].length;
	}
	out.append(src.slice(at));
	return out;
}
function edgeLookup(e) {
	const to = node(e.to),
		from = e.from;
	const chips = {
		output: T("tpl.chip.output", { from }),
		input: T("tpl.chip.input", { from }),
		reasoning: T("tpl.chip.reasoning", { from }),
		toolTrace: T("tpl.chip.toolTrace", { from }),
		transcript: T("tpl.chip.transcript"),
	};
	return name => {
		const token = name.match(/^x\.(\w+)$/)?.[1],
			part = token === "tool_trace" ? "toolTrace" : token;
		if (part) return hasPart(e, part) ? { chip: chips[part] ?? part } : undefined;
		return {
			topic: { chip: T("tpl.chip.topic") },
			"to.id": e.to,
			"to.description": to?.description || undefined,
			"from.id": from,
			"mixture.name": mix.name,
			"mixture.member_count": mix.members.length,
			"edge.id": eid(e),
			"edge.traversal": 1,
		}[name];
	};
}
/* The same template with its {{…}} left in, struck through where this path does not carry the part. */
function templateSource(textValue, e) {
	const out = h("div", { class: "tpl" }),
		re = /\{\{[^}]*\}\}/g;
	let at = 0,
		m;
	while ((m = re.exec(textValue))) {
		out.append(textValue.slice(at, m.index));
		const token = m[0].match(/x\.(\w+)/)?.[1],
			part = token === "tool_trace" ? "toolTrace" : token,
			off = part && PARTS.includes(part) && !hasPart(e, part);
		out.append(h("span", { class: off ? "x" : "v", title: off ? T("tpl.notCarried", { part: token }) : null }, m[0]));
		at = m.index + m[0].length;
	}
	out.append(textValue.slice(at));
	return out;
}
function insertChips(area, e) {
	const tokens = [
		"{{topic}}",
		"{{from.id}}",
		"{{to.id}}",
		...PARTS.map(p => `{{x.${partToken(p)}}}`),
		"{{> moa-parts}}",
	];
	return h(
		"div",
		{ class: "picks", style: { marginTop: "6px" } },
		tokens.map(token => {
			const name = token.match(/x\.(\w+)/)?.[1],
				part = name === "tool_trace" ? "toolTrace" : name,
				off = e && part && !hasPart(e, part);
			return h(
				"button",
				{
					class: cls("pick tok", off && "off"),
					type: "button",
					title: off ? T("tpl.insert.off", { part: name }) : T("tpl.insert"),
					onclick: () => {
						area.focus();
						area.setRangeText(token, area.selectionStart, area.selectionEnd, "end");
						area.dispatchEvent(new Event("input", { bubbles: true }));
					},
				},
				token,
			);
		}),
	);
}
function decisionList(e) {
	const n = node(e.from),
		others = liveOuts(e.from).filter(x => x !== e);
	const steps = [TX("decide.answers", { from: e.from })];
	if (n.terminate) steps.push(TX("decide.stop"));
	if (cap(e) !== undefined) steps.push(TX("decide.cap", { n: cap(e) }));
	steps.push(others.length ? TX("decide.judge", { n: others.length }) : TX("decide.only"));
	return h(
		"ol",
		{ class: "story" },
		steps.map(s => h("li", { style: { cursor: "default" } }, h("span", {}, s))),
	);
}
function wouldLoop(e) {
	const seen = new Set(),
		walk = id => {
			if (id === e.from) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return liveOuts(id).some(x => walk(x.to));
		};
	return walk(e.to);
}
function moveSource(e, to) {
	const old = node(e.from);
	keepingFallbacks(() => {
		e.from = to;
	});
	if (old.route && !outs(old.id).length) delete old.route;
	const now = node(to);
	if (liveOuts(to).length >= 2 && !now.route?.instructions)
		now.route = { ...now.route, instructions: starterRoute(to) };
}
function panelFanout(e) {
	return [
		h(
			"div",
			{ class: "phead" },
			h("div", { class: "eyebrow" }, icon("lock", 11), T("fan.eyebrow"), h("span", { class: "ms" }, "M4")),
			h(
				"div",
				{ class: "ptitle" },
				h(
					"h2",
					{},
					jump(e.from),
					icon("right"),
					e.to.map((id, i) => [i > 0 && "+", jump(id)]),
				),
			),
			actions(
				act("diamond", T("menu.convert"), () => commit(T("act.convert"), () => convertFanout(e))),
				act("trash", T("common.delete"), () => deleteEdge(e), { danger: true }),
			),
		),
		h("div", { class: "says" }, TX("fan.says", { from: e.from, n: e.to.length })),
		issueList(issuesFor("edge", e.$k)),
		sec(
			T("fan.stored"),
			null,
			h(
				"div",
				{ class: "tpl" },
				(lines => {
					tomlEdge(lines, bare(e));
					return lines.filter(Boolean).join("\n");
				})([]),
			),
			h("p", { class: "hint", style: { marginTop: "6px" } }, T("fan.kept")),
		),
	];
}
function panelEdge(e) {
	if (isFan(e)) return panelFanout(e);
	const from = node(e.from),
		to = node(e.to),
		branch = isBranch(e),
		toVerdict = !isModel(to),
		sibs = liveOuts(e.from),
		isFb = from?.route?.fallback === eid(e);
	const name = envName(e),
		inline = name === null,
		source = envText(e),
		tr = e.x?.transcript,
		trObj = typeof tr === "object" ? tr : {};
	const flipPart = (part, btn) => {
		if (hasPart(e, part) && partsOf(e).length === 1) {
			btn.classList.add("shake");
			setTimeout(() => btn.classList.remove("shake"), 320);
			return toast(T("parts.min"), { bad: true });
		}
		commit(
			T("act.parts"),
			() => {
				if (hasPart(e, part)) {
					if (part === "transcript" && typeof e.x.transcript === "object") e.$transcript = e.x.transcript;
					delete e.x[part];
				} else (e.x ??= {})[part] = part === "transcript" && e.$transcript ? e.$transcript : true; // turning it back on restores its folding settings
			},
			{ quiet: true },
		);
	};
	const setTranscript = (key, v) => {
		const next = { ...trObj };
		v === undefined || v === "" ? delete next[key] : (next[key] = v);
		e.x.transcript = Object.keys(next).length ? next : true;
	};
	const capStep = d =>
		commit(
			T("act.cap"),
			() => {
				const v = (cap(e) ?? 0) + d;
				v <= 0 ? delete e.maxTraversals : (e.maxTraversals = v);
			},
			{ quiet: true },
		);
	const envOptions = [
		...presetNames("envelopes")
			.filter(p => !RESERVED_ENVELOPES.includes(p.name) || p.name === name)
			.map(p => [p.name, p.name]),
		...(name && source === undefined ? [[name, T("prompt.role.missing", { name })]] : []),
		[" custom", T("envelope.custom")],
	];
	return [
		h(
			"div",
			{ class: "phead" },
			h(
				"div",
				{ class: "eyebrow" },
				icon(toVerdict ? "scale" : "mail", 11),
				toVerdict ? T("path.eyebrow.verdict") : T("path.eyebrow"),
				branch && h("span", { class: "judge" }, T("path.eyebrow.judge")),
			),
			h("div", { class: "ptitle" }, h("h2", {}, jump(e.from), icon(e.from === e.to ? "loop" : "right"), jump(e.to))),
			actions(
				act("spark", T("path.insert"), () => insertOn(e)),
				!toVerdict && e.from !== e.to && act("swap", T("path.reverse"), () => reverseEdge(e)),
				act("trash", T("common.delete"), () => deleteEdge(e), { danger: true }),
			),
		),
		live("div", { class: "says" }, () => [
			branch ? TX("path.says.judge", { from: e.from }) : TX("path.says.always", { from: e.from }),
			" ",
			toVerdict
				? TX("path.says.verdict", { parts: partsText(e) })
				: TX("path.says.model", { to: e.to, parts: partsText(e), envelope: envName(e) ?? T("path.envelope.own") }),
			cap(e) !== undefined && [" ", TX("path.says.cap", { n: cap(e) })],
		]),
		live("div", {}, () => issueList(issuesFor("edge", e.$k))),
		sec(
			T("when.title"),
			{ id: "when" },
			branch
				? fld(
						T("when.label"),
						text(e, "when", { area: true, rows: 2, placeholder: T("when.placeholder"), field: "when" }),
						{ hint: T("when.hint") },
					)
				: [
						h("p", { class: "hint" }, TX("when.only", { from: e.from })),
						e.when && fld(T("when.stored"), text(e, "when", { area: true })),
					],
			fld(
				T("cap.label"),
				h(
					"div",
					{ class: "step", "data-field": "cap" },
					h(
						"button",
						{
							type: "button",
							class: "inf",
							"aria-pressed": String(cap(e) === undefined),
							onclick: () =>
								cap(e) !== undefined &&
								commit(
									T("act.cap"),
									() => {
										delete e.maxTraversals;
									},
									{ quiet: true },
								),
						},
						T("cap.none"),
					),
					h(
						"button",
						{
							type: "button",
							"aria-label": T("cap.fewer"),
							onclick: () => capStep(-1),
							disabled: cap(e) === undefined,
						},
						icon("minus", 12),
					),
					text(e, "maxTraversals", { number: true, placeholder: "∞", label: T("cap.label") }),
					h(
						"button",
						{ type: "button", "aria-label": T("cap.more"), onclick: () => capStep(1) },
						icon("plus", 12),
					),
				),
				{
					hint:
						cap(e) !== undefined
							? sibs.length > 1
								? T("cap.hint.rest", { n: cap(e) })
								: T("cap.hint.ends", { n: cap(e), from: e.from })
							: e.from === e.to || wouldLoop(e)
								? T("cap.hint.loop")
								: null,
				},
			),
			branch &&
				toggle(
					isFb,
					T("unsure.toggle"),
					isFb
						? null
						: from.route?.fallback && from.route.fallback !== "pause"
							? T("unsure.other")
							: T("unsure.pause"),
					() =>
						commit(
							T("act.unsure"),
							() => {
								from.route ??= { instructions: "" };
								isFb ? delete from.route.fallback : (from.route.fallback = eid(e));
							},
							{ quiet: true },
						),
				).also(el => (el.style.marginTop = "12px")),
		),
		sec(
			T("parts.title"),
			{ id: "parts", aside: T("parts.from", { from: e.from }) },
			h(
				"div",
				{ class: "parts" },
				PARTS.map(part => {
					const on = hasPart(e, part),
						btn = h(
							"button",
							{ class: "part", type: "button", "aria-pressed": String(on), onclick: () => flipPart(part, btn) },
							h("i", {}, icon("check", 11)),
							h("span", {}, h("b", {}, partToken(part)), h("small", {}, partHint(part))),
						);
					return [
						btn,
						part === "transcript" &&
							on &&
							!toVerdict &&
							h(
								"div",
								{ class: "part sub" },
								fld(
									T("transcript.fold"),
									seg(
										[
											["", T("transcript.default")],
											["verbatim", T("transcript.verbatim")],
											["compact", T("transcript.compact")],
											["snapcompact", T("transcript.snap")],
										],
										trObj.optimize ?? "",
										v => commit(T("act.transcript"), () => setTranscript("optimize", v), { quiet: true }),
									),
									{
										hint:
											trObj.optimize === "snapcompact"
												? T("transcript.snap.hint", { to: e.to })
												: trObj.optimize === "compact"
													? T("transcript.compact.hint")
													: null,
									},
								),
								fld(
									T("transcript.budget"),
									text(trObj, "budgetTokens", {
										number: true,
										label: T("transcript.budget"),
										placeholder: T("transcript.budget.default"),
										k: "fold",
										set: v => setTranscript("budgetTokens", v),
									}),
									{ aside: T("output.tokens"), hint: T("transcript.budget.hint") },
								),
							),
					];
				}),
			),
		),
		toVerdict
			? sec(T("arrives.title"), { id: "envelope" }, h("p", { class: "hint" }, T("arrives.verdict")))
			: sec(
					T("arrives.title"),
					{ id: "envelope", aside: T("arrives.as", { to: e.to }) },
					h(
						"div",
						{ style: { display: "flex", gap: "6px" } },
						choose(
							envOptions,
							inline ? " custom" : name,
							v =>
								commit(
									T("act.envelope"),
									() => {
										if (v === " custom") {
											e.envelope = source ?? "{{> moa-parts}}";
											e.$inline = true;
										} else {
											delete e.$inline;
											v === "handoff" ? delete e.envelope : (e.envelope = v);
										}
									},
									{ quiet: true },
								),
							{ "data-field": "envelope" },
						),
						!inline &&
							h(
								"button",
								{
									class: "btn",
									type: "button",
									"data-nav": "",
									title: T("envelope.open"),
									"aria-label": T("envelope.open"),
									disabled: source === undefined,
									onclick: () => openPreset("envelopes", name),
								},
								icon("edit"),
							),
					),
					/* Writing a template and seeing what the model will read are one view: the preview below follows every keystroke. */
					source !== undefined &&
						inline && [
							(area => [fld(T("envelope.edit"), area), insertChips(area, e)])(
								text(e, "envelope", { area: true, mono: true, rows: 4, keep: true }),
							),
							fld(
								T("envelope.read", { to: e.to }),
								live("div", {}, () => renderTemplate(envText(e) ?? "", edgeLookup(e))),
								{ hint: T("envelope.read.hint") },
							),
						],
					source !== undefined &&
						!inline && [
							fld(
								T("envelope.read", { to: e.to }),
								live("div", {}, () => renderTemplate(envText(e) ?? "", edgeLookup(e))),
								{ hint: T("envelope.read.hint") },
							),
							fld(
								T("envelope.template"),
								live("div", {}, () => templateSource(envText(e) ?? "", e)),
								{ hint: T("envelope.struck") },
							),
						],
				),
		sec(
			T("decide.title"),
			{ aside: T("decide.aside") },
			live("div", {}, () => decisionList(e)),
		),
		sec(
			T("details.title"),
			null,
			fld(
				T("details.id"),
				idInput(e, true).also(el => (el.className = "in mono")),
				{ hint: T("details.id.hint") },
			),
			h(
				"div",
				{ class: "row2" },
				fld(
					T("details.from"),
					choose(
						mix.members.filter(isModel).map(n => [n.id, n.id]),
						e.from,
						v => commit(T("act.moveSource", { id: v }), () => moveSource(e, v), { quiet: true }),
					),
				),
				fld(
					T("details.to"),
					choose(
						mix.members.map(n => [n.id, n.id]),
						e.to,
						v =>
							commit(
								T("act.retarget", { id: v }),
								() =>
									keepingFallbacks(() => {
										e.to = v;
									}),
								{ quiet: true },
							),
					),
				),
			),
			showField(e, T("show.edge", { from: e.from }), [
				["", T("show.inherit")],
				["always", T("show.always")],
				["never", T("show.never")],
			]),
		),
	];
}
function panelMulti() {
	const ids = [...multi];
	return [
		h(
			"div",
			{ class: "phead" },
			h("div", { class: "eyebrow" }, T("multi.eyebrow")),
			h("div", { class: "ptitle" }, h("h2", {}, TN("multi.count", ids.length))),
			actions(act("trash", T("multi.delete", { n: ids.length }), () => deleteNodes(ids), { danger: true })),
		),
		h("div", { class: "says" }, TX("multi.says")),
		h(
			"div",
			{ class: "plist", style: { marginTop: "12px" } },
			ids.map(id =>
				h(
					"button",
					{ class: "preset", type: "button", "data-nav": "", onclick: () => select({ kind: "node", id }) },
					h("b", {}, id),
					h("small", {}, isModel(node(id)) ? node(id).model : T("card.verdict")),
				),
			),
		),
	];
}

/* ═══════════════════════════ THE FILE TAB ═══════════════════════════ */
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
function tomlHtml(source) {
	let inMulti = false;
	return source
		.split("\n")
		.map(line => {
			if (inMulti) {
				if (/(^|[^\\])"""/.test(line)) inMulti = false;
				return '<span class="ts">' + esc(line) + "</span>";
			}
			if (/^\s*#/.test(line)) return '<span class="tc">' + esc(line) + "</span>";
			if (/^\s*\[/.test(line)) return '<span class="tt">' + esc(line) + "</span>";
			const m = line.match(/^(\s*[\w."-]+)(\s*=\s*)(.*)$/);
			if (!m) return esc(line);
			if (m[3].startsWith('"""') && !/[^\\]"""/.test(m[3].slice(3))) inMulti = true;
			const value = esc(m[3]).replace(
				/"(?:[^"\\]|\\.)*"|\b(?:true|false)\b|\b\d+(?:\.\d+)?\b|\b[\w-]+(?=\s*=)/g,
				tok =>
					tok[0] === '"'
						? `<span class="ts">${tok}</span>`
						: /^(true|false|\d)/.test(tok)
							? `<span class="tn">${tok}</span>`
							: `<span class="tk">${tok}</span>`,
			);
			return '<span class="tk">' + esc(m[1]) + "</span>" + m[2] + value;
		})
		.join("\n");
}
/* Split a MIXTURES.toml into the blocks the canvas knows: one per mixture header, member and path. */
function tomlBlocks(source) {
	const blocks = [];
	let block = { key: null, lines: [] },
		m = -1,
		member = -1,
		path = -1,
		inMulti = false;
	for (const line of source.replace(/\n$/, "").split("\n")) {
		const head = !inMulti && /^\s*\[\[?([\w.]+)\]\]?\s*$/.exec(line)?.[1];
		if (head === "mixtures" || head === "mixtures.members" || head === "mixtures.edges") {
			while (block.lines.length && !block.lines.at(-1).trim()) block.lines.pop();
			if (block.lines.length) blocks.push(block);
			if (head === "mixtures") {
				m++;
				member = path = -1;
				block = { key: { m, kind: "mix" }, lines: [] };
			} else if (head === "mixtures.members") block = { key: { m, kind: "node", i: ++member }, lines: [] };
			else block = { key: { m, kind: "edge", i: ++path }, lines: [] };
		}
		block.lines.push(line);
		const quotes = (line.match(/(?<!\\)"""/g) ?? []).length;
		if (quotes % 2) inMulti = !inMulti;
	}
	if (block.lines.length) blocks.push(block);
	return blocks;
}
/* What is on disk while this file has no changes of yours; otherwise exactly what saving the draft on screen would write. */
function tomlView() {
	const s = srcOf(cur.sid),
		f = fileOf(cur.sid),
		changed = fileDirty(cur.sid);
	const source = changed ? fileText(cur.sid) : (f.base.text ?? f.base.toml ?? "");
	const mine = changed
		? sendable(cur.sid).map.indexOf(cur.index)
		: (f.base.doc.mixtures ?? []).findIndex(x => x.name === mix.$o?.name);
	const pre = h(
		"div",
		{ class: "toml" },
		tomlBlocks(source).map(b => {
			const here = b.key && b.key.m === mine,
				target = !here
					? null
					: b.key.kind === "mix"
						? { kind: "mix" }
						: b.key.kind === "node"
							? mix.members[b.key.i] && { kind: "node", id: mix.members[b.key.i].id }
							: mix.edges[b.key.i] && { kind: "edge", id: mix.edges[b.key.i].$k };
			const on = target && (target.kind === "mix" ? !sel && !multi.size : selIs(target.kind, target.id));
			const el = h("span", {
				class: cls("blk", here && "mine", on && "on", b.key && !here && "far"),
				onclick: () => {
					if (target) select(target.kind === "mix" ? null : target, { keepTab: true });
				},
			});
			el.innerHTML = tomlHtml(b.lines.join("\n"));
			return el;
		}),
	);
	return [
		h(
			"div",
			{ class: "tomlbar" },
			h("span", { title: s.path }, s.displayPath),
			h(
				"button",
				{
					class: "btn small",
					type: "button",
					"data-nav": "",
					onclick: () => copyText(source, T("toml.copied", { path: s.displayPath })),
				},
				icon("copy", 12),
				T("common.copy"),
			),
		),
		h(
			"p",
			{ class: "hint", style: { margin: "0 0 8px" } },
			!changed ? (f.base.exists ? T("toml.disk") : T("toml.absent")) : T("toml.draft"),
		),
		pre,
	];
}
const panelToml = () => live("div", {}, tomlView);

/* ═══════════════════════════ FRAME ═══════════════════════════ */
function focusField(section) {
	const body = $("pbody"),
		el = body.querySelector(`[data-sec="${section}"],[data-field="${section}"]`);
	if (!el) return;
	const card = el.closest(".card,.sec") ?? el;
	body.scrollTo({ top: Math.max(0, card.offsetTop - 12) });
	card.classList.remove("fresh");
	void card.offsetWidth;
	card.classList.add("fresh");
	const input = el.matches("input,textarea,select,button")
		? el
		: el.querySelector("textarea,input:not([type=range]),select");
	if (!readOnly()) input?.focus({ preventScroll: true });
}
function renderPanel() {
	const panel = $("panel"),
		body = $("pbody");
	panel.classList.toggle("shut", !panelOpen || !mix);
	panel.inert = !panelOpen || !mix;
	$("reopen").hidden = panelOpen || !mix;
	if (!mix) {
		body.replaceChildren();
		return;
	}
	const keepScroll = body.dataset.for === selKey() + tab ? body.scrollTop : 0;
	const n = sel?.kind === "node" && node(sel.id),
		e = sel?.kind === "edge" && edge(sel.id),
		ro = readOnly(),
		s = srcOf(cur.sid);
	$("ptabs").replaceChildren(
		...[
			h(
				"button",
				{
					role: "tab",
					type: "button",
					"aria-selected": String(tab === "inspect"),
					onclick: () => {
						tab = "inspect";
						renderPanel();
					},
				},
				n
					? isModel(n)
						? T("tab.model")
						: T("tab.verdict")
					: e
						? T("tab.path")
						: multi.size
							? T("tab.selection")
							: T("tab.mixture"),
			),
			h(
				"button",
				{
					role: "tab",
					type: "button",
					"aria-selected": String(tab === "toml"),
					onclick: () => {
						tab = "toml";
						renderPanel();
					},
				},
				T("tab.file"),
			),
			(sel || multi.size > 0) &&
				h(
					"button",
					{ type: "button", onclick: () => select(null), title: T("tab.back.title") },
					icon("left", 12),
					T("tab.mixture"),
				),
			h("span", { class: "sp" }),
			h(
				"button",
				{
					class: "x",
					type: "button",
					title: T("tab.hide"),
					"aria-label": T("tab.hide.aria"),
					onclick: () => {
						panelOpen = false;
						render();
						if (!camTouched) fit(true);
					},
				},
				icon("side"),
			),
		].filter(Boolean),
	);
	liveList = [];
	const content =
		tab === "toml"
			? panelToml()
			: multi.size
				? panelMulti()
				: n
					? isModel(n)
						? panelModel(n)
						: panelVerdict(n)
					: e
						? panelEdge(e)
						: panelMixture();
	body.replaceChildren(
		...[
			ro &&
				tab !== "toml" &&
				h(
					"div",
					{ class: "says w", style: { marginTop: "8px" } },
					icon("lock"),
					" ",
					fileOf(cur.sid).base.broken ? T("ro.broken") : T("ro.why", { why: s.readOnly }),
					h(
						"div",
						{ style: { marginTop: "8px" } },
						h(
							"button",
							{ class: "btn small", type: "button", "data-nav": "", onclick: () => openMove(mix) },
							icon("dup"),
							T("ro.copy"),
						),
					),
				),
			content,
		]
			.flat(Infinity)
			.filter(Boolean),
	);
	if (ro && tab !== "toml")
		for (const el of body.querySelectorAll("input,textarea,select,button:not([data-nav])")) el.disabled = true;
	body.dataset.for = selKey() + tab;
	body.scrollTop = keepScroll;
	if (tab === "toml") body.querySelector(".blk.on")?.scrollIntoView({ block: "nearest" });
	if (focusSection && tab === "inspect") {
		const section = focusSection;
		focusSection = null;
		focusField(section);
	}
}
