"use strict";
/* Mixture Studio · sidebar: every mixture in every MIXTURES.toml NeoPi reads for this workspace.
   It stays out of the way until the pointer reaches the left edge (or B, or the button in the bar; it can be pinned).
   Rename, move, copy, duplicate and delete are draft edits like any other: undoable, and written only on Save.
   Rows and menus hold on to the mixture itself, never to its position in a list, so a file that changes on disk
   while a menu is open cannot make an action land on a different mixture. */
let sideOpen = false,
	sidePinned = false,
	sideFilter = "",
	sideTimer = null;
let sideRename = null; // {m, why?}: the mixture whose name is being typed in the list
const side = $("side");
/* Keeping the list open beside the canvas needs room for both. In a narrow window it only ever overlays. */
const canPin = () => innerWidth - side.offsetWidth >= 480;
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
		sideRename = null;
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
	} else if (sideOpen && !canPin()) sideOpen = false;
	else {
		sidePinned = canPin();
		sideOpen = true;
	}
	render();
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
/* Later files win. Which other files' drafts define `name`, leaving out one mixture (the one being moved or renamed). */
const definesName = (x, name, except) =>
	!!fileOf(x.id)?.doc.mixtures.some(m => m !== except && m.name === name && !isScratch(m));
const shadowOf = (s, name, except) =>
	sources.filter(x => x.order > s.order && definesName(x, name, except)).at(-1) ?? null;
const hiddenBy = (s, name, except) =>
	sources.filter(x => x.order < s.order && definesName(x, name, except)).at(-1) ?? null;
function rowTags(s, m) {
	const tags = [],
		state = mixState(m, s.id),
		shadow = shadowOf(s, m.name),
		disk = m.$o && srcOf(m.$o.sid)?.mixtures.find(x => x.name === m.$o.name);
	if (isScratch(m))
		tags.push(h("span", { class: "tag local", title: T("side.tag.scratch.title") }, T("side.tag.scratch")));
	else if (state)
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
	if (sidePinned && !canPin()) sidePinned = false;
	side.classList.toggle("open", sideOpen);
	side.classList.toggle("pinned", sideOpen && sidePinned);
	side.setAttribute("aria-hidden", String(!sideOpen));
	side.inert = !sideOpen;
	if (!sideOpen) {
		side.replaceChildren();
		return;
	}
	/* What is being typed survives every redraw: a poll, an answer from NeoPi, an edit elsewhere. */
	const typed = (el =>
		el && { value: el.value, start: el.selectionStart, end: el.selectionEnd, focus: document.activeElement === el })(
		side.querySelector("input.rn"),
	);
	const keep = side.querySelector(".sbody")?.scrollTop ?? 0,
		hadFind = document.activeElement?.id === "sfind";
	if (sideRename && !whereIs(sideRename.m)) sideRename = null;
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
	const changed = dirtyFiles().length,
		pin = canPin();
	side.replaceChildren(
		...[
			h(
				"div",
				{ class: "shead" },
				h("h2", {}, T("side.title")),
				pin &&
					h(
						"button",
						{
							class: "icon-btn",
							type: "button",
							"aria-pressed": String(sidePinned),
							title: sidePinned ? T("side.unpin") : T("side.pin"),
							"aria-label": sidePinned ? T("side.unpin") : T("side.pin"),
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
	const rn = side.querySelector("input.rn");
	if (rn) {
		if (typed) {
			rn.value = typed.value;
			rn.dispatchEvent(new Event("input"));
		}
		if (!typed || typed.focus) {
			rn.focus({ preventScroll: true });
			typed ? rn.setSelectionRange(typed.start, typed.end) : rn.select();
		}
	}
}
function groupEl(s, qy) {
	const f = fileOf(s.id),
		list = f?.doc.mixtures ?? [],
		ok = writable(s);
	const rows = list.filter(
		m =>
			!qy ||
			m === sideRename?.m ||
			m.name.toLowerCase().includes(qy) ||
			(m.description ?? "").toLowerCase().includes(qy),
	);
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
		rows.map(m => rowEl2(s, m)),
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
	/* Drop a dragged mixture on a file to move it there; out of a read-only file it can only be a copy. */
	if (ok) {
		const copies = ev => ev.ctrlKey || ev.altKey || !writable(srcOf(whereIs(dragRow)?.sid));
		group.addEventListener("dragover", ev => {
			if (!dragRow || whereIs(dragRow)?.sid === s.id) return;
			ev.preventDefault();
			ev.dataTransfer.dropEffect = copies(ev) ? "copy" : "move";
			group.classList.add("drop");
		});
		group.addEventListener("dragleave", ev => {
			if (!group.contains(ev.relatedTarget)) group.classList.remove("drop");
		});
		group.addEventListener("drop", ev => {
			ev.preventDefault();
			group.classList.remove("drop");
			const m = dragRow,
				copy = m && copies(ev);
			dragRow = null;
			if (m && whereIs(m) && whereIs(m).sid !== s.id) transfer(m, s.id, { copy });
		});
	}
	return group;
}
let dragRow = null; // the mixture being dragged
function rowEl2(s, m) {
	const on = mix === m,
		ok = writable(s);
	if (sideRename?.m === m) {
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
		const say = h("span", {});
		const paint = () => {
			const why = input.value.trim() === m.name ? null : nameProblem(s.id, input.value.trim(), m);
			input.classList.toggle("bad", !!why);
			say.textContent = why ?? T("side.rename.hint");
			say.style.color = why ? "var(--err)" : "";
			return why;
		};
		/* A name that cannot be used keeps the field open with the reason under it: nothing typed is thrown away. */
		const keepIt = () => {
			if (paint()) return input.focus();
			sideRename = null;
			renameMixture(m, input.value.trim());
			renderSide();
		};
		input._settle = () => {
			keepIt();
			return sideRename?.m !== m;
		};
		input.addEventListener("input", paint);
		input.addEventListener("keydown", ev => {
			if (!(ev.ctrlKey || ev.metaKey)) ev.stopPropagation();
			if (ev.key === "Enter") {
				ev.preventDefault();
				keepIt();
			}
			if (ev.key === "Escape") {
				sideRename = null;
				renderSide();
			}
		});
		input.addEventListener("blur", () =>
			setTimeout(() => {
				if (sideRename?.m !== m || document.activeElement === input || !input.isConnected) return;
				if (paint()) return;
				sideRename = null;
				renameMixture(m, input.value.trim());
				renderSide();
			}, 0),
		);
		paint();
		return h("div", { class: "srow on" }, h("div", { class: "t" }, input, h("div", { class: "d" }, say)));
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
						sideRename = { m };
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
					openPop(ev.currentTarget, rowMenu(s, m), { align: "left", width: 300 });
				},
			},
			icon("dots"),
		),
	);
	row.addEventListener("click", () => openMixture(m));
	row.addEventListener("keydown", ev => {
		if (ev.target !== row) return;
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			openMixture(m);
		}
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			ev.preventDefault();
			const all = [...side.querySelectorAll(".srow,.snew")];
			all[all.indexOf(row) + (ev.key === "ArrowDown" ? 1 : -1)]?.focus();
		}
		if (ev.key === "Delete" && ok) {
			ev.preventDefault();
			deleteMixture(m);
		}
	});
	row.addEventListener("dragstart", ev => {
		dragRow = m;
		ev.dataTransfer.effectAllowed = ok ? "copyMove" : "copy";
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
function rowMenu(s, m) {
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
				sideRename = { m };
				renderSide();
			},
			{ disabled: !ok },
		),
		mi("dup", T("side.duplicate"), () => duplicateMixture(m), { disabled: !ok }),
		others.length > 0 && h("hr"),
		ok &&
			others.map(x =>
				mi("right", T("side.moveTo", { dest: dest(x) }), () => transfer(m, x.id, {}), { title: x.path }),
			),
		others.map(x =>
			mi("copy", T("side.copyTo", { dest: dest(x) }), () => transfer(m, x.id, { copy: true }), { title: x.path }),
		),
		!others.length && h("div", { class: "pad hint" }, T("side.noDest")),
		h("hr"),
		mi("trash", T("common.delete"), () => deleteMixture(m), { danger: true, disabled: !ok }),
	];
}

/* ── opening ── */
/* openMixture(mixture) or openMixture(sourceId, index). */
function openMixture(target, index, { keepSide } = {}) {
	const at = typeof target === "string" ? { sid: target, index } : whereIs(target);
	if (typeof target !== "string") keepSide = index?.keepSide;
	if (!at || !fileOf(at.sid)?.doc.mixtures[at.index]) return;
	if (trial) trialEnd();
	endConnect();
	closePop();
	cur = at;
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
/* With nothing chosen: the mixture this session answers with, else the first one in the file /moa web was asked for
   ("/moa web user" opens on the user file), else the first one in the nearest file you can edit. */
function pickMixture() {
	const all = sources.flatMap(s => (fileOf(s.id)?.doc.mixtures ?? []).map((m, i) => ({ s, m, i })));
	const first =
		all.find(x => x.m.name === boot.selected && !shadowOf(x.s, x.m.name)) ??
		all.find(x => x.s.id === boot.initialSourceId) ??
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
		toast(T("guard.readOnlyFile", { path: s?.displayPath ?? "?" }), { bad: true });
		return false;
	}
	return true;
}
/* Returns the reason when the name cannot be used, else null. */
function renameMixture(m, name) {
	const at = whereIs(m);
	if (!at || name === m.name) return null;
	if (!editable(at.sid)) return null;
	const why = nameProblem(at.sid, name, m);
	if (why) return why;
	const old = m.name;
	commit(
		T("act.renameMixture", { from: old, to: name }),
		() => {
			m.name = name;
		},
		{ quiet: true },
	);
	const other = shadowOf(srcOf(at.sid), name, m);
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
	panelOpen = true; // the name is typed in the inspector, so it has to be there
	commit(
		T("act.newMixture"),
		() => {
			const d = fileOf(sid).doc;
			d.mixtures.push({ name: freeName(sid, "untitled"), entry: "", members: [], edges: [] });
			cur = { sid, index: d.mixtures.length - 1 };
			sel = null;
			multi.clear();
			tab = "inspect";
		},
		{ quiet: true },
	);
	fit();
	if (!sidePinned) closeSide(true);
	focusField("name");
	$("pbody").querySelector('[data-field="name"]')?.select();
}
function duplicateMixture(m) {
	const at = whereIs(m);
	if (!at || !editable(at.sid)) return;
	commit(T("act.duplicateMixture", { name: m.name }), () => {
		const d = fileOf(at.sid).doc,
			copy = clone(m);
		delete copy.$o;
		copy.name = freeName(at.sid, m.name.replace(/-copy(-\d+)?$/, "") + "-copy");
		for (const e of copy.edges) e.$k = "k" + ++edgeSeq;
		d.mixtures.splice(at.index + 1, 0, copy);
		cur = { sid: at.sid, index: at.index + 1 };
		sel = null;
		multi.clear();
	});
	fit();
}
function deleteMixture(m) {
	const at = whereIs(m);
	if (!at || !editable(at.sid)) return;
	const sid = at.sid,
		s = srcOf(sid),
		d = fileOf(sid).doc,
		open = mix;
	const go = () => {
		closeSheet();
		commit(T("act.deleteMixture", { name: m.name }), () => {
			const index = d.mixtures.indexOf(m);
			if (index < 0) return;
			d.mixtures.splice(index, 1);
			reopen(open === m ? null : open, sid, null);
		});
		fit();
	};
	if (isScratch(m)) return go();
	const revealed = hiddenBy(s, m.name, m),
		last = d.mixtures.length === 1;
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
				!shadowOf(s, m.name, m) &&
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
						Object.keys(d.roles ?? {}).length || Object.keys(d.envelopes ?? {}).length
							? T("mixdel.lastPresets")
							: T("mixdel.last"),
					),
				),
		),
		note: T("delete.note"),
		primary: { label: T("common.delete"), danger: true, run: go },
	});
}
/* Presets a mixture would read differently in another file, and so takes along as its own copies.
   A mixture names presets explicitly (a role, an envelope, a verdict's render) and implicitly (every path without an
   envelope reads "handoff", every verdict without a render reads "verdict", every run reads "entry" and "limit").
   Each name resolves mixture → file → built in. If the name would land on different text in the destination file,
   because the old file overrode it or the new one does, the mixture keeps the text it has now. */
function borrowed(m, fromDoc, toDoc) {
	const need = { roles: new Set(), envelopes: new Set(["entry", "limit"]) };
	for (const n of m.members) {
		if (n.kind === "verdict") need.envelopes.add(n.render ?? "verdict");
		else if (n.systemPrompt === undefined && n.role !== undefined) need.roles.add(n.role);
	}
	for (const e of m.edges) {
		if (e.envelope === undefined) need.envelopes.add("handoff");
		else if (!isInline(e.envelope) && !e.$inline) need.envelopes.add(e.envelope);
		if (e.joinEnvelope !== undefined && !isInline(e.joinEnvelope)) need.envelopes.add(e.joinEnvelope);
	}
	const out = [],
		read = (d, kind, name) =>
			own(d[kind], name) ? d[kind][name] : own(boot.bundled[kind], name) ? boot.bundled[kind][name] : undefined;
	for (const kind of ["roles", "envelopes"])
		for (const name of need[kind]) {
			if (own(m[kind], name)) continue;
			const here = read(fromDoc, kind, name);
			if (here !== undefined && here !== read(toDoc, kind, name)) out.push([kind, name, here]);
		}
	return out;
}
function transfer(m, toSid, { copy, name } = {}) {
	const at = whereIs(m),
		to = fileOf(toSid),
		dest = srcOf(toSid);
	if (!at || !to || at.sid === toSid) return;
	const from = fileOf(at.sid);
	if (!copy && !editable(at.sid)) return;
	if (!editable(toSid)) return;
	const as = name ?? m.name;
	if (nameProblem(toSid, as, null)) return openMove(m, { to: toSid, copy, name: as }); // a collision needs a decision, so ask
	const carried = borrowed(m, from.doc, to.doc);
	commit(
		copy
			? T("act.copyMixture", { name: m.name, path: dest.displayPath })
			: T("act.moveMixture", { name: m.name, path: dest.displayPath }),
		() => {
			const moving = copy ? clone(m) : m;
			if (copy) {
				delete moving.$o;
				for (const e of moving.edges) e.$k = "k" + ++edgeSeq;
			} else from.doc.mixtures.splice(from.doc.mixtures.indexOf(m), 1);
			for (const [kind, key, text] of carried) (moving[kind] ??= {})[key] = text;
			moving.name = as;
			to.doc.mixtures.push(moving);
			cur = { sid: toSid, index: to.doc.mixtures.length - 1 };
			sel = null;
			multi.clear();
		},
		{ quiet: true },
	);
	const moved = to.doc.mixtures.at(-1),
		other = shadowOf(dest, as, moved),
		hides = !other && hiddenBy(dest, as, moved);
	toast(
		[
			copy ? T("move.done.copy", { path: dest.displayPath }) : T("move.done", { path: dest.displayPath }),
			carried.length && TN("move.carried", carried.length),
			other && T("move.shadowed", { path: other.displayPath, name: as }),
			hides && T("move.hides", { path: hides.displayPath, name: as }),
			T("move.onSave"),
		]
			.filter(Boolean)
			.join(" "),
		{ undo: true, bad: !!other },
	);
	fit();
}
/* The same move as a dialog: pick the file, move or copy, and settle the name when it collides.
   What it will do to the other files (which one wins, what it hides, what it takes along) is restated on every keystroke. */
function openMove(m, preset = {}) {
	const at = whereIs(m);
	if (!at) return;
	const s = srcOf(at.sid),
		dests = sources.filter(x => x.id !== at.sid && writable(x)),
		canMove = writable(s);
	if (!dests.length) return toast(T("side.noDest"), { bad: true });
	let to = preset.to ?? dests.at(-1).id,
		copy = preset.copy ?? !canMove,
		name = preset.name ?? m.name;
	const input = liveTidy(
		h("input", { class: "in mono", value: name, spellcheck: "false", autocomplete: "off", "data-autofocus": "" }),
		true,
	);
	const msg = h("p", { class: "fieldmsg" }),
		impact = h("ul", { class: "impact" }),
		what = h("div", {}),
		where = h("div", { class: "plist" });
	const sheet = openSheet({
		title: canMove ? T("move.title", { name: m.name }) : T("move.title.copy", { name: m.name }),
		sub: canMove ? T("move.sub", { path: s.displayPath }) : T("move.sub.readOnly", { path: s.displayPath }),
		body: [
			canMove && fld(T("move.what"), what),
			fld(T("move.where"), where),
			fld(T("move.name"), input),
			msg,
			impact,
		],
		primary: {
			label: "",
			run: () => {
				if (!whereIs(m)) return closeSheet();
				closeSheet();
				transfer(m, to, { copy, name });
			},
		},
	});
	const go = sheet.querySelector(".btn.primary");
	const paint = () => {
		const dest = srcOf(to),
			why = nameProblem(to, name, null),
			moving = copy ? null : m;
		const other = !why && shadowOf(dest, name, moving),
			hides = !why && hiddenBy(dest, name, moving),
			carried = borrowed(m, fileOf(at.sid).doc, fileOf(to).doc);
		input.classList.toggle("bad", !!why);
		msg.textContent = why ?? "";
		go.disabled = !!why;
		go.textContent = copy ? T("move.go.copy") : T("move.go");
		what.replaceChildren(
			seg(
				[
					["move", T("move.move")],
					["copy", T("move.copy")],
				],
				copy ? "copy" : "move",
				v => {
					copy = v === "copy";
					paint();
				},
			),
		);
		where.replaceChildren(
			...dests.map(x =>
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
		);
		impact.replaceChildren(
			...[
				carried.length > 0 &&
					h(
						"li",
						{},
						icon("layers"),
						h("span", {}, TN("move.willCarry", carried.length, { names: carried.map(c => c[1]).join(", ") })),
					),
				other && h("li", {}, icon("warn"), h("span", {}, TX("move.willShadow", { path: other.displayPath, name }))),
				hides && h("li", {}, icon("info"), h("span", {}, TX("move.willHide", { path: hides.displayPath, name }))),
			].filter(Boolean),
		);
	};
	input.addEventListener("input", () => {
		name = input.value.trim();
		paint();
	});
	input.addEventListener("keydown", ev => {
		if (ev.key === "Enter" && !go.disabled) go.click();
	});
	paint();
}
