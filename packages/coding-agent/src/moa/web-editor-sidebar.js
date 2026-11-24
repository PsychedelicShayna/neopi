"use strict";
/* Mixture Studio · sidebar: every mixture in every MIXTURES.toml NeoPi reads for this workspace.
   It stays out of the way until the pointer reaches the left edge (or B, or the button in the bar; it can be pinned).
   Rename, move, copy, duplicate and delete are draft edits like any other: undoable, and written only on Save. */
let sideOpen = false,
	sidePinned = false,
	sideFilter = "",
	sideTimer = null,
	sideRename = null;
const side = $("side");
function openSide() {
	clearTimeout(sideTimer);
	if (sideOpen) return;
	sideOpen = true;
	renderSide();
}
/* Leaving does not slam it shut: there is a grace period, and it stays while a menu or a rename it started is open. */
function closeSide(now) {
	clearTimeout(sideTimer);
	if (!sideOpen || sidePinned || (!mix && !now)) return;
	const busy = () =>
		sideRename ||
		(popEl && side.contains(popOwner)) ||
		(side.matches(":focus-within") && side.querySelector("input:focus"));
	if (now === true) {
		sideOpen = false;
		renderSide();
		return;
	}
	sideTimer = setTimeout(
		() => {
			if (busy() || side.matches(":hover")) return;
			sideOpen = false;
			renderSide();
		},
		now === false ? 420 : 0,
	);
}
function toggleSide() {
	if (sideOpen && sidePinned) {
		sidePinned = false;
		sideOpen = false;
	} else {
		sidePinned = true;
		sideOpen = true;
	}
	renderSide();
	renderBar();
	if (mix && !camTouched) fit(true);
	if (sideOpen) side.querySelector(".srow.on,.snew")?.focus?.();
}
$("edge").addEventListener("pointerenter", () => {
	sideTimer = setTimeout(openSide, 110);
});
$("edge").addEventListener("pointerleave", () => {
	if (!sideOpen) clearTimeout(sideTimer);
});
$("edge").addEventListener("click", openSide);
side.addEventListener("pointerenter", () => clearTimeout(sideTimer));
side.addEventListener("pointerleave", () => closeSide(false));
side.addEventListener("focusout", () =>
	setTimeout(() => {
		if (!side.matches(":focus-within") && !side.matches(":hover")) closeSide(false);
	}, 0),
);

/* ── what the list knows about each mixture ── */
const scopeLabel = s => (s.kind === "user" ? T("side.scope.user") : T("side.scope.project"));
function sourceWhat(s) {
	if (s.kind === "user") return T("side.what.user");
	const projects = sources.filter(x => x.kind === "project");
	return projects.length < 2
		? T("side.what.project")
		: s === projects.at(-1)
			? T("side.what.nearest")
			: T("side.what.outer");
}
/* Later files win. A name is shadowed when a later file's draft also defines it. */
function shadowOf(s, name) {
	return (
		sources
			.filter(x => x.order > s.order && fileOf(x.id)?.doc.mixtures.some(m => m.name === name && !isScratch(m)))
			.at(-1) ?? null
	);
}
function withMixture(sid, index, fn) {
	const keep = [cur, doc, mix];
	cur = { sid, index };
	doc = fileOf(sid).doc;
	mix = doc.mixtures[index];
	try {
		return fn();
	} finally {
		[cur, doc, mix] = keep;
	}
}
function rowTags(s, m) {
	const tags = [],
		state = mixState(m, s.id),
		shadow = shadowOf(s, m.name),
		disk = m.$o && srcOf(m.$o.sid)?.mixtures.find(x => x.name === m.$o.name);
	if (state)
		tags.push(
			h(
				"span",
				{ class: "tag local", title: T("side.tag.unsaved.title") },
				{
					new: T("side.tag.new"),
					moved: T("side.tag.moved"),
					renamed: T("side.tag.renamed"),
					edited: T("side.tag.edited"),
				}[state],
			),
		);
	if (shadow)
		tags.push(
			h(
				"span",
				{ class: "tag warn", title: T("side.tag.shadowed.title", { path: shadow.displayPath }) },
				T("side.tag.shadowed", { scope: scopeWord(shadow) }),
			),
		);
	else if (disk && !state && disk.status === "invalid")
		tags.push(h("span", { class: "tag bad", title: T("side.tag.notRunnable.title") }, T("side.tag.notRunnable")));
	else if (disk?.status === "registered" && boot.selected === disk.name)
		tags.push(h("span", { class: "tag ok", title: T("side.tag.inUse.title") }, T("side.tag.inUse")));
	return tags;
}
function renderSide() {
	side.classList.toggle("open", sideOpen);
	side.classList.toggle("pinned", sideOpen && sidePinned);
	side.setAttribute("aria-hidden", String(!sideOpen));
	if (!sideOpen) {
		side.replaceChildren();
		return;
	}
	const keep = side.querySelector(".sbody")?.scrollTop ?? 0,
		hadFind = document.activeElement?.id === "sfind";
	const qy = sideFilter.trim().toLowerCase(),
		total = sources.reduce((n, s) => n + (fileOf(s.id)?.doc.mixtures.length ?? 0), 0);
	const find = h("input", {
		class: "in",
		id: "sfind",
		value: sideFilter,
		placeholder: T("side.find"),
		spellcheck: "false",
		autocomplete: "off",
		"aria-label": T("side.find"),
	});
	find.addEventListener("input", () => {
		sideFilter = find.value;
		renderSide();
	});
	find.addEventListener("keydown", ev => {
		if (ev.key === "Escape" && sideFilter) {
			ev.stopPropagation();
			sideFilter = "";
			renderSide();
		}
	});
	const changed = dirtyFiles().length;
	side.replaceChildren(
		...[
			h(
				"div",
				{ class: "shead" },
				h("h2", {}, T("side.title")),
				h(
					"button",
					{
						class: "icon-btn",
						type: "button",
						"aria-pressed": String(sidePinned),
						title: sidePinned ? T("side.unpin") : T("side.pin"),
						onclick: toggleSide,
					},
					icon("pin"),
				),
				!sidePinned &&
					h(
						"button",
						{
							class: "icon-btn",
							type: "button",
							title: T("common.close.title"),
							"aria-label": T("common.close"),
							onclick: () => closeSide(true),
						},
						icon("x"),
					),
			),
			total > 6 && h("div", { class: "sfind" }, icon("search", 13), find),
			h(
				"div",
				{ class: "sbody" },
				sources.map(s => groupEl(s, qy)),
			),
			h(
				"div",
				{ class: "sfoot" },
				changed
					? [
							TN("side.foot.changed", changed),
							" ",
							h(
								"button",
								{
									class: "btn small primary",
									type: "button",
									style: { marginTop: "6px" },
									onclick: () => openSave(),
								},
								T("side.foot.review"),
							),
						]
					: T("side.foot"),
			),
		].filter(Boolean),
	);
	side.querySelector(".sbody").scrollTop = keep;
	if (hadFind) {
		const f = $("sfind");
		f?.focus();
		f?.setSelectionRange(f.value.length, f.value.length);
	}
	if (sideRename) side.querySelector("input.rn")?.focus();
}
function groupEl(s, qy) {
	const f = fileOf(s.id),
		list = f?.doc.mixtures ?? [],
		ok = writable(s);
	const rows = list
		.map((m, i) => [m, i])
		.filter(([m]) => !qy || m.name.toLowerCase().includes(qy) || (m.description ?? "").toLowerCase().includes(qy));
	const group = h(
		"section",
		{ class: "sgroup", "data-sid": s.id },
		h(
			"header",
			{},
			h("span", { class: cls("scope", s.kind === "user" && "user") }, scopeLabel(s)),
			h("span", { class: "what" }, sourceWhat(s)),
			!ok &&
				h(
					"span",
					{ title: T("side.readOnly.title"), style: { color: "var(--ink3)", display: "flex" } },
					icon("lock", 13),
				),
			h("span", { class: "path", title: s.path }, h("bdi", {}, s.displayPath)),
		),
		f?.base.broken &&
			h("div", { class: "why bad" }, icon("warn", 13), h("span", {}, T("side.broken", { why: f.base.broken }))),
		!f?.base.broken &&
			s.readOnly &&
			h("div", { class: "why" }, icon("lock", 13), h("span", {}, T("side.readOnly", { why: s.readOnly }))),
		f?.theirs && h("div", { class: "why bad" }, icon("warn", 13), h("span", {}, T("side.changedOnDisk"))),
		rows.map(([m, i]) => rowEl2(s, m, i)),
		!rows.length &&
			h(
				"div",
				{ class: "sempty" },
				qy ? T("side.noMatch") : f?.base.exists ? T("side.emptyFile") : T("side.noFile"),
			),
		ok &&
			!qy &&
			h(
				"button",
				{ class: "snew", type: "button", onclick: () => newMixture(s.id) },
				icon("plus", 13),
				T("side.new"),
			),
	);
	/* drop a dragged mixture on a file to move it there */
	if (ok) {
		group.addEventListener("dragover", ev => {
			if (!dragRow || dragRow.sid === s.id) return;
			ev.preventDefault();
			ev.dataTransfer.dropEffect = ev.ctrlKey || ev.altKey ? "copy" : "move";
			group.classList.add("drop");
		});
		group.addEventListener("dragleave", ev => {
			if (!group.contains(ev.relatedTarget)) group.classList.remove("drop");
		});
		group.addEventListener("drop", ev => {
			ev.preventDefault();
			group.classList.remove("drop");
			const d = dragRow;
			dragRow = null;
			if (d && d.sid !== s.id) transfer(d.sid, d.index, s.id, { copy: ev.ctrlKey || ev.altKey });
		});
	}
	return group;
}
let dragRow = null;
function rowEl2(s, m, i) {
	const on = cur?.sid === s.id && cur.index === i,
		renaming = sideRename?.sid === s.id && sideRename.index === i,
		ok = writable(s);
	if (renaming) {
		const input = liveTidy(
			h("input", {
				class: "rn",
				value: m.name,
				spellcheck: "false",
				autocomplete: "off",
				"aria-label": T("side.rename.aria", { name: m.name }),
			}),
			true,
		);
		let done = false;
		const finish = keep => {
			if (done) return;
			done = true;
			sideRename = null;
			const why = keep ? renameMixture(s.id, i, input.value.trim()) : null;
			if (why) toast(why, { bad: true });
			renderSide();
		};
		input.addEventListener("input", () => input.classList.toggle("bad", !!nameProblem(s.id, input.value.trim(), m)));
		input.addEventListener("keydown", ev => {
			ev.stopPropagation();
			if (ev.key === "Enter") finish(true);
			if (ev.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(true));
		setTimeout(() => {
			input.focus();
			input.select();
		});
		return h(
			"div",
			{ class: "srow on" },
			h("div", { class: "t" }, input, h("div", { class: "d" }, h("span", {}, T("side.rename.hint")))),
		);
	}
	const row = h(
		"div",
		{
			class: cls("srow", on && "on"),
			tabIndex: 0,
			role: "button",
			draggable: true,
			"aria-current": on ? "true" : null,
			title: T("side.row.title", { name: m.name }),
		},
		h(
			"div",
			{ class: "t" },
			h("div", { class: "n" }, h("span", {}, m.name)),
			h(
				"div",
				{ class: "d" },
				h(
					"span",
					{},
					m.description || (m.members.length ? TN("side.members", m.members.length) : T("side.emptyMix")),
				),
				rowTags(s, m),
			),
		),
		ok &&
			h(
				"button",
				{
					class: "icon-btn",
					type: "button",
					title: T("side.rename"),
					"aria-label": T("side.rename.aria2", { name: m.name }),
					onclick: ev => {
						ev.stopPropagation();
						sideRename = { sid: s.id, index: i };
						renderSide();
					},
				},
				icon("edit"),
			),
		h(
			"button",
			{
				class: "icon-btn",
				type: "button",
				title: T("side.more"),
				"aria-label": T("side.more.aria", { name: m.name }),
				"aria-haspopup": "menu",
				onclick: ev => {
					ev.stopPropagation();
					openPop(ev.currentTarget, rowMenu(s, m, i), { align: "left", width: 300 });
				},
			},
			icon("dots"),
		),
	);
	row.addEventListener("click", () => openMixture(s.id, i));
	row.addEventListener("keydown", ev => {
		if (ev.target !== row) return;
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			openMixture(s.id, i);
		}
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			ev.preventDefault();
			const all = [...side.querySelectorAll(".srow,.snew")];
			all[all.indexOf(row) + (ev.key === "ArrowDown" ? 1 : -1)]?.focus();
		}
		if (ev.key === "Delete" && ok) {
			ev.preventDefault();
			deleteMixture(s.id, i);
		}
	});
	row.addEventListener("dragstart", ev => {
		dragRow = { sid: s.id, index: i };
		ev.dataTransfer.effectAllowed = "copyMove";
		ev.dataTransfer.setData("text/plain", "mixture/" + m.name);
		row.classList.add("dragging");
	});
	row.addEventListener("dragend", () => {
		dragRow = null;
		row.classList.remove("dragging");
		for (const g of side.querySelectorAll(".drop")) g.classList.remove("drop");
	});
	return row;
}
/* Move and copy are one click each from here: every file that can take the mixture is its own menu item. */
function rowMenu(s, m, i) {
	const ok = writable(s),
		others = sources.filter(x => x.id !== s.id && writable(x));
	const dest = x => `${scopeLabel(x)} · ${x.displayPath}`;
	return [
		h("h4", {}, m.name),
		mi(
			"edit",
			T("side.rename"),
			() => {
				openSide();
				sideRename = { sid: s.id, index: i };
				renderSide();
			},
			{ disabled: !ok },
		),
		mi("dup", T("side.duplicate"), () => duplicateMixture(s.id, i), { disabled: !ok }),
		others.length > 0 && h("hr"),
		ok &&
			others.map(x =>
				mi("right", T("side.moveTo", { dest: dest(x) }), () => transfer(s.id, i, x.id, {}), { title: x.path }),
			),
		others.map(x =>
			mi("copy", T("side.copyTo", { dest: dest(x) }), () => transfer(s.id, i, x.id, { copy: true }), {
				title: x.path,
			}),
		),
		!others.length && h("div", { class: "pad hint" }, T("side.noDest")),
		h("hr"),
		mi("trash", T("common.delete"), () => deleteMixture(s.id, i), { danger: true, disabled: !ok }),
	];
}

/* ── opening ── */
function openMixture(sid, index, { keepSide } = {}) {
	if (trial) trialEnd();
	endConnect();
	closePop();
	cur = { sid, index };
	sel = null;
	multi.clear();
	typingKey = null;
	tab = "inspect";
	sync();
	edited();
	render();
	fit();
	if (!keepSide && !sidePinned) closeSide(true);
}
/* With nothing chosen: the session's mixture if there is one, else the first one in the nearest file you can edit. */
function pickMixture() {
	const all = sources.flatMap(s => (fileOf(s.id)?.doc.mixtures ?? []).map((m, i) => ({ s, m, i })));
	const first =
		all.find(x => x.m.name === boot.selected && !shadowOf(x.s, x.m.name)) ??
		all.find(x => x.s === all.findLast(y => writable(y.s))?.s) ??
		all[0];
	cur = first ? { sid: first.s.id, index: first.i } : null;
	sel = null;
	sync();
}

/* ── draft edits on whole mixtures ── */
function nameProblem(sid, name, self) {
	if (!name) return T("name.empty");
	if (!NAME_RE.test(name)) return T("chk.name.invalid");
	if (fileOf(sid).doc.mixtures.some(m => m !== self && m.name === name)) return T("name.taken", { name });
	return null;
}
const freeName = (sid, base) => {
	const taken = new Set(fileOf(sid).doc.mixtures.map(m => m.name));
	return taken.has(base) ? freeId(base + "-", taken) : base;
};
function editable(sid) {
	const s = srcOf(sid);
	if (trial) {
		toast(T("guard.trial"), { bad: true });
		return false;
	}
	if (!writable(s)) {
		toast(T("guard.readOnlyFile", { path: s.displayPath }), { bad: true });
		return false;
	}
	return true;
}
function renameMixture(sid, index, name) {
	const m = fileOf(sid).doc.mixtures[index];
	if (!m || name === m.name) return null;
	if (!editable(sid)) return null;
	const why = nameProblem(sid, name, m);
	if (why) return why;
	const old = m.name;
	commit(
		T("act.renameMixture", { from: old, to: name }),
		() => {
			m.name = name;
		},
		{ quiet: true },
	);
	const other = shadowOf(srcOf(sid), name);
	toast(
		other
			? T("name.renamed.shadowed", { name, path: other.displayPath })
			: m.$o
				? T("name.renamed.saved", { name })
				: T("name.renamed", { name }),
		{ undo: true, bad: !!other },
	);
	return null;
}
function newMixture(sid) {
	if (!editable(sid)) return;
	let index;
	commit(
		T("act.newMixture"),
		() => {
			const d = fileOf(sid).doc;
			d.mixtures.push({ name: freeName(sid, "untitled"), entry: "", members: [], edges: [] });
			index = d.mixtures.length - 1;
			cur = { sid, index };
			sel = null;
			multi.clear();
		},
		{ quiet: true },
	);
	fit();
	if (!sidePinned) closeSide(true);
	focusField("name");
	$("pbody").querySelector('[data-field="name"]')?.select();
}
function duplicateMixture(sid, index) {
	if (!editable(sid)) return;
	const m = fileOf(sid).doc.mixtures[index];
	commit(T("act.duplicateMixture", { name: m.name }), () => {
		const d = fileOf(sid).doc,
			copy = clone(m);
		delete copy.$o;
		copy.name = freeName(sid, m.name.replace(/-\d+$/, "") + "-copy");
		for (const e of copy.edges) e.$k = "k" + ++edgeSeq;
		d.mixtures.splice(index + 1, 0, copy);
		cur = { sid, index: index + 1 };
		sel = null;
		multi.clear();
	});
	fit();
}
function deleteMixture(sid, index) {
	if (!editable(sid)) return;
	const s = srcOf(sid),
		m = fileOf(sid).doc.mixtures[index];
	const go = () => {
		closeSheet();
		commit(T("act.deleteMixture", { name: m.name }), () => {
			fileOf(sid).doc.mixtures.splice(index, 1);
			if (cur?.sid === sid) {
				if (cur.index === index) {
					cur = null;
					sel = null;
				} else if (cur.index > index) cur.index--;
			}
			sync();
			if (!mix) pickMixture();
		});
		fit();
	};
	if (isScratch(m)) return go();
	const revealed = sources
			.filter(x => x.order < s.order && fileOf(x.id)?.doc.mixtures.some(o => o.name === m.name))
			.at(-1),
		last = fileOf(sid).doc.mixtures.length === 1;
	openSheet({
		title: T("mixdel.title", { name: m.name }),
		sub: T("mixdel.sub", { path: s.displayPath }),
		body: h(
			"ul",
			{ class: "impact" },
			h(
				"li",
				{},
				icon("trash"),
				h("span", {}, TN("mixdel.members", m.members.length), " · ", TN("mixdel.paths", m.edges.length)),
			),
			m.$o && h("li", {}, icon("layers"), h("span", {}, TX("mixdel.roster", { name: m.$o.name }))),
			revealed &&
				h(
					"li",
					{},
					icon("warn"),
					h("span", {}, TX("mixdel.reveals", { path: revealed.displayPath, name: m.name })),
				),
			last &&
				h(
					"li",
					{},
					icon("file"),
					h(
						"span",
						{},
						doc &&
							(Object.keys(fileOf(sid).doc.roles ?? {}).length ||
								Object.keys(fileOf(sid).doc.envelopes ?? {}).length)
							? T("mixdel.lastPresets")
							: T("mixdel.last"),
					),
				),
		),
		note: T("delete.note"),
		primary: { label: T("common.delete"), danger: true, run: go },
	});
}
/* File-level presets a mixture leans on. They belong to the file, so a mixture that leaves takes its own copies. */
function borrowed(m, d) {
	const need = { roles: new Set(), envelopes: new Set() };
	for (const n of m.members) {
		if (n.kind === "verdict") {
			if (n.render !== undefined) need.envelopes.add(n.render);
		} else if (n.systemPrompt === undefined && n.role !== undefined) need.roles.add(n.role);
	}
	for (const e of m.edges)
		if (e.envelope !== undefined && !isInline(e.envelope) && !e.$inline) need.envelopes.add(e.envelope);
	for (const reserved of ["entry", "limit"]) need.envelopes.add(reserved);
	const out = [];
	for (const kind of ["roles", "envelopes"])
		for (const name of need[kind]) if (!own(m[kind], name) && own(d[kind], name)) out.push([kind, name]);
	return out;
}
function transfer(fromSid, index, toSid, { copy, name } = {}) {
	const from = fileOf(fromSid),
		to = fileOf(toSid),
		m = from.doc.mixtures[index],
		dest = srcOf(toSid);
	if (!m || !to) return;
	if (!copy && !editable(fromSid)) return;
	if (!editable(toSid)) return;
	const as = name ?? m.name;
	if (nameProblem(toSid, as, null)) return openMove(fromSid, index, { to: toSid, copy, name: as }); // a collision needs a decision, so ask
	const carried = borrowed(m, from.doc);
	commit(
		copy
			? T("act.copyMixture", { name: m.name, path: dest.displayPath })
			: T("act.moveMixture", { name: m.name, path: dest.displayPath }),
		() => {
			const moving = copy ? clone(m) : m;
			if (copy) {
				delete moving.$o;
				for (const e of moving.edges) e.$k = "k" + ++edgeSeq;
			} else from.doc.mixtures.splice(index, 1);
			for (const [kind, key] of carried) (moving[kind] ??= {})[key] = from.doc[kind][key];
			moving.name = as;
			to.doc.mixtures.push(moving);
			cur = { sid: toSid, index: to.doc.mixtures.length - 1 };
			sel = null;
			multi.clear();
		},
		{ quiet: true },
	);
	const other = shadowOf(dest, as);
	toast(
		[
			copy ? T("move.done.copy", { path: dest.displayPath }) : T("move.done", { path: dest.displayPath }),
			carried.length && TN("move.carried", carried.length),
			other && T("move.shadowed", { path: other.displayPath, name: as }),
			T("move.onSave"),
		]
			.filter(Boolean)
			.join(" "),
		{ undo: true },
	);
	fit();
}
/* The same move as a dialog: pick the file, move or copy, and settle the name when it collides. */
function openMove(fromSid, index, preset = {}) {
	const s = srcOf(fromSid),
		m = fileOf(fromSid).doc.mixtures[index],
		dests = sources.filter(x => x.id !== fromSid && writable(x)),
		canMove = writable(s);
	let to = preset.to ?? dests.at(-1)?.id,
		copy = preset.copy ?? !canMove,
		name = preset.name ?? m.name;
	if (!dests.length) return toast(T("side.noDest"), { bad: true });
	const paint = () => {
		const why = nameProblem(to, name, null),
			dest = srcOf(to),
			other = !why && shadowOf(dest, name),
			hides =
				!why &&
				sources
					.filter(
						x =>
							x.order < dest.order && x.id !== fromSid && fileOf(x.id)?.doc.mixtures.some(o => o.name === name),
					)
					.at(-1);
		const carried = borrowed(m, fileOf(fromSid).doc);
		const input = liveTidy(
			h("input", {
				class: cls("in mono", why && "bad"),
				value: name,
				spellcheck: "false",
				autocomplete: "off",
				"data-autofocus": why ? "" : null,
			}),
			true,
		);
		input.addEventListener("input", () => {
			name = input.value.trim();
			const bad = nameProblem(to, name, null);
			input.classList.toggle("bad", !!bad);
			msg.textContent = bad ?? "";
			go.disabled = !!bad;
		});
		input.addEventListener("keydown", ev => {
			if (ev.key === "Enter" && !go.disabled) go.click();
		});
		const msg = h("p", { style: { color: "var(--err)", minHeight: "18px" } }, why ?? "");
		const sheet = openSheet({
			title: T("move.title", { name: m.name }),
			sub: T("move.sub", { path: s.displayPath }),
			body: [
				fld(
					T("move.what"),
					seg(
						[
							["move", T("move.move"), canMove ? null : T("move.move.no")],
							["copy", T("move.copy")],
						],
						copy ? "copy" : "move",
						v => {
							if (v === "move" && !canMove) return toast(T("move.move.no"), { bad: true });
							copy = v === "copy";
							paint();
						},
					),
				),
				fld(
					T("move.where"),
					h(
						"div",
						{ class: "plist" },
						dests.map(x =>
							h(
								"button",
								{
									class: cls("preset", x.id === to && "on"),
									type: "button",
									"aria-pressed": String(x.id === to),
									onclick: () => {
										to = x.id;
										paint();
									},
								},
								h("span", { class: cls("tag", x.kind === "user" ? "judge" : "local") }, scopeLabel(x)),
								h("b", { title: x.path }, x.displayPath),
								h("small", {}, sourceWhat(x)),
							),
						),
					),
				),
				fld(T("move.name"), input),
				msg,
				h(
					"ul",
					{ class: "impact" },
					carried.length > 0 && h("li", {}, icon("layers"), h("span", {}, TN("move.willCarry", carried.length))),
					other &&
						h("li", {}, icon("warn"), h("span", {}, TX("move.willShadow", { path: other.displayPath, name }))),
					hides &&
						h("li", {}, icon("info"), h("span", {}, TX("move.willHide", { path: hides.displayPath, name }))),
				),
			],
			primary: {
				label: copy ? T("move.go.copy") : T("move.go"),
				disabled: !!why,
				run: () => {
					closeSheet();
					transfer(fromSid, index, to, { copy, name });
				},
			},
		});
		const go = sheet.querySelector(".btn.primary");
	};
	paint();
}
