"use strict";
/* Mixture Studio · save: validation by the harness, the Save review, and what happens when a file changed on disk.
   One Save writes every changed file in a single all-or-nothing request, so a move between two files cannot half-happen.
   Saving is the only thing here that touches disk, and it never overwrites a file that changed since it was loaded. */

/* ═══════════════════════════ VALIDATION BY THE HARNESS ═══════════════════════════
   The page checks structure as you type. NeoPi checks everything it would check at registration (models resolve,
   templates compile, helpers exist), a moment after you stop typing. Its findings appear next to the page's own. */
let draftTimer = null;
function edited() {
	clearTimeout(draftTimer);
	if (!cur) {
		server = { seq: server.seq + 1, issues: [], reports: [], toml: null, map: [], pending: false };
		return;
	}
	server.pending = true;
	draftTimer = setTimeout(askHarness, 350);
}
async function askHarness() {
	if (!cur) return;
	const seq = ++server.seq,
		sid = cur.sid,
		{ doc: sent, map } = sendable(sid);
	const asked = { index: cur.index, models: Object.fromEntries(mix.members.map(n => [n.id, n.model])) };
	const res = await api.draft(sid, sent);
	if (seq !== server.seq || cur?.sid !== sid) return; // a newer edit is already on its way
	server.pending = false;
	if (!res.ok) {
		server.failed = res.data?.error ?? T("harness.silent");
		soft();
		return;
	}
	const v = res.data.validation ?? {};
	server = {
		seq,
		pending: false,
		failed: null,
		map,
		asked,
		toml: res.data.toml ?? "",
		diagnostics: res.data.parseDiagnostics ?? [],
		reports: res.data.reports ?? [],
		issues: [
			...(v.errors ?? []).map(i => ({ ...i, sev: "e" })),
			...(v.warnings ?? []).map(i => ({ ...i, sev: "w" })),
		],
	};
	soft();
}
/* What NeoPi resolved a member's selector to, if its answer is about the selector that is still there. */
function harnessMember(id) {
	if (!server.asked || server.asked.index !== cur.index || server.asked.models[id] !== node(id)?.model) return null;
	return server.reports.find(r => server.map[r.index] === cur.index)?.members?.[id] ?? null;
}

/* ═══════════════════════════ DIFF ═══════════════════════════ */
function lineDiff(a, b) {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const A = a.slice(head, a.length - tail),
		B = b.slice(head, b.length - tail),
		out = a.slice(0, head).map(s => [" ", s]);
	if (A.length * B.length > 3e6) {
		for (const s of A) out.push(["d", s]);
		for (const s of B) out.push(["a", s]);
	} // too big to align: show it as a replacement
	else {
		const n = A.length,
			m = B.length,
			L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--)
			for (let j = m - 1; j >= 0; j--)
				L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
		let i = 0,
			j = 0;
		while (i < n && j < m) {
			if (A[i] === B[j]) {
				out.push([" ", A[i]]);
				i++;
				j++;
			} else if (L[i + 1][j] >= L[i][j + 1]) out.push(["d", A[i++]]);
			else out.push(["a", B[j++]]);
		}
		while (i < n) out.push(["d", A[i++]]);
		while (j < m) out.push(["a", B[j++]]);
	}
	for (const s of a.slice(a.length - tail)) out.push([" ", s]);
	return out;
}
const linesOf = source => (source ? source.replace(/\n$/, "").split("\n") : []);
function diffView(before, after) {
	const rows = lineDiff(linesOf(before), linesOf(after)),
		keep = new Set();
	rows.forEach(([t], i) => {
		if (t !== " ") for (let k = i - 2; k <= i + 2; k++) keep.add(k);
	});
	const box = h("div", { class: "diff" });
	let gap = false,
		added = 0,
		removed = 0;
	rows.forEach(([t, s], i) => {
		if (t === "a") added++;
		if (t === "d") removed++;
		if (!keep.has(i)) {
			if (!gap) {
				box.append(h("div", { class: "gap" }, "⋯"));
				gap = true;
			}
			return;
		}
		gap = false;
		box.append(h("div", { class: t === " " ? "" : t }, (t === " " ? "  " : t === "a" ? "+ " : "− ") + s));
	});
	if (!added && !removed) box.replaceChildren(h("div", { class: "gap" }, T("diff.none")));
	return { box, added, removed };
}

/* ═══════════════════════════ REVIEW AND SAVE ═══════════════════════════ */
/* In words: what happened to each mixture of one file since it was read from disk. */
function changeList(s) {
	const f = fileOf(s.id),
		lines = [];
	for (const m of f.doc.mixtures) {
		if (isScratch(m)) {
			lines.push(["info", TX("chg.scratch", { name: m.name })]);
			continue;
		}
		const state = mixState(m, s.id),
			from = m.$o && srcOf(m.$o.sid);
		if (state === "new") lines.push(["plus", TX("chg.new", { name: m.name })]);
		if (state === "moved")
			lines.push([
				"right",
				m.name === m.$o.name
					? TX("chg.movedIn", { name: m.name, path: from?.displayPath ?? "?" })
					: TX("chg.movedInAs", { was: m.$o.name, name: m.name, path: from?.displayPath ?? "?" }),
			]);
		if (state === "renamed") lines.push(["edit", TX("chg.renamed", { was: m.$o.name, name: m.name })]);
		if (state === "edited") lines.push(["edit", TX("chg.edited", { name: m.name })]);
	}
	for (const was of f.base.doc.mixtures ?? []) {
		if (f.doc.mixtures.some(m => m.$o?.sid === s.id && m.$o.name === was.name)) continue;
		const now = sources.find(
			x => x.id !== s.id && fileOf(x.id)?.doc.mixtures.some(m => m.$o?.sid === s.id && m.$o.name === was.name),
		);
		lines.push(
			now
				? ["right", TX("chg.movedOut", { name: was.name, path: now.displayPath })]
				: ["trash", TX("chg.removed", { name: was.name })],
		);
	}
	if (
		structure(f.doc.roles ?? {}) !== structure(f.base.doc.roles ?? {}) ||
		structure(f.doc.envelopes ?? {}) !== structure(f.base.doc.envelopes ?? {})
	)
		lines.push(["layers", T("chg.presets")]);
	return lines;
}
/* Files that gain a mixture are written first, so a failure part-way can never leave a mixture in neither file. */
const gains = sid => fileOf(sid).doc.mixtures.filter(m => !isScratch(m) && m.$o?.sid !== sid).length;
function jumpTo(sid, index, issue) {
	closeSheet();
	if (cur?.sid !== sid || cur.index !== index) openMixture(sid, index, { keepSide: true });
	if (issue) goIssue(issue);
}
let saving = false,
	confirmedLoss = new Set();
async function openSave() {
	if (saving) return;
	if (trial) trialEnd();
	endConnect();
	const changed = dirtyFiles().sort((a, b) => gains(b.id) - gains(a.id));
	if (!changed.length) return toast(T("save.nothing"));
	const body = h("div", {}, h("p", { class: "hint" }, T("save.asking")));
	const sheet = openSheet({
		wide: true,
		title: T("save.title"),
		sub: TN("save.sub", changed.length),
		body,
		note: "",
		primary: { label: T("save.go"), disabled: true, run: () => {} },
	});
	const go = sheet.querySelector(".btn.primary"),
		note = sheet.querySelector("footer .note");
	const drafts = await Promise.all(
		changed.map(async s => {
			const { doc: sent, map } = sendable(s.id);
			return { s, sent, map, res: await api.draft(s.id, sent) };
		}),
	);
	if (sheetEl?.firstChild !== sheet) return; // closed while waiting
	let blockers = 0;
	const check = (state, title, sub, extra) =>
		h(
			"div",
			{ class: "check " + state },
			h("i", {}, icon(state === "ok" ? "check" : state === "no" ? "x" : state === "unk" ? "info" : "dots", 11)),
			h("span", {}, title, sub && h("small", {}, sub), extra),
		);
	const proofs = [];
	const sections = drafts.map(({ s, sent, map, res }) => {
		const f = fileOf(s.id),
			text = res.ok ? (res.data.toml ?? "") : "",
			before = f.base.text ?? f.base.toml ?? "";
		const { box, added, removed } = diffView(before, text),
			checks = [];
		if (!res.ok) {
			blockers++;
			checks.push(check("no", T("save.chk.unreachable"), res.data?.error ?? T("harness.silent")));
		} else {
			const errs = (res.data.validation?.errors ?? []).map(it => {
				const m = /^mixtures\[(\d+)\]\.?(.*)$/.exec(it.path),
					index = m ? map[+m[1]] : undefined,
					target = index !== undefined ? f.doc.mixtures[index] : null;
				return { it, index, target, blocks: !target || mixState(target, s.id) !== null };
			});
			const blocking = errs.filter(e => e.blocks),
				carried = new Set(errs.filter(e => !e.blocks).map(e => e.target.name));
			const lossy = res.data.parseDiagnostics ?? [];
			if (blocking.length || lossy.length) {
				blockers++;
				checks.push(
					check(
						"no",
						TN("save.chk.errors", blocking.length + lossy.length),
						null,
						h(
							"div",
							{ style: { display: "grid", gap: "4px", marginTop: "6px" } },
							lossy.map(line => h("div", { class: "hint" }, line)),
							blocking
								.slice(0, 6)
								.map(({ it, index, target }) =>
									h(
										"button",
										{
											class: "btn small",
											type: "button",
											style: {
												justifyContent: "start",
												height: "auto",
												minHeight: "30px",
												padding: "5px 8px",
												whiteSpace: "normal",
												textAlign: "left",
											},
											onclick: () => jumpTo(s.id, index ?? 0),
										},
										(target ? target.name + ": " : "") + it.message,
									),
								),
							blocking.length > 6 && h("div", { class: "hint" }, T("save.chk.more", { n: blocking.length - 6 })),
						),
					),
				);
			} else checks.push(check("ok", T("save.chk.valid"), T("save.chk.valid.sub")));
			if (carried.size)
				checks.push(
					check("unk", T("save.chk.carried", { names: [...carried].join(", ") }), T("save.chk.carried.sub")),
				);
		}
		if (f.theirs) {
			blockers++;
			checks.push(
				check(
					"no",
					T("save.chk.conflict"),
					T("save.chk.conflict.sub"),
					conflictActions(s, () => openSave()),
				),
			);
		} else
			checks.push(
				check(
					"ok",
					f.base.exists ? T("save.chk.fresh") : T("save.chk.absent"),
					f.base.exists ? T("save.chk.fresh.sub") : T("save.chk.absent.sub"),
				),
			);
		const losing = f.base.parseDiagnostics ?? [];
		if (losing.length && !f.theirs) {
			const agreed = confirmedLoss.has(s.id + f.base.hash);
			if (!agreed) blockers++;
			checks.push(
				check(
					agreed ? "unk" : "no",
					T("save.chk.lossy"),
					null,
					h(
						"div",
						{ style: { marginTop: "6px", display: "grid", gap: "6px" } },
						losing.slice(0, 5).map(line => h("div", { class: "hint" }, line)),
						toggle(agreed, T("save.chk.lossy.ok"), T("save.chk.lossy.sub"), () => {
							agreed ? confirmedLoss.delete(s.id + f.base.hash) : confirmedLoss.add(s.id + f.base.hash);
							openSave();
						}),
					),
				),
			);
		} else if (/^\s*#/m.test(before) && removed)
			checks.push(check("unk", T("save.chk.comments"), T("save.chk.comments.sub")));
		const proof = h("div", {}, check("", T("save.chk.proof"), T("save.chk.proof.sub")));
		proofs.push([s, proof]);
		checks.push(proof);
		const words = changeList(s);
		return h(
			"section",
			{},
			h(
				"div",
				{ class: "filehead" },
				h("span", { class: cls("tag", s.kind === "user" ? "judge" : "local") }, scopeLabel(s)),
				h("span", { title: s.path }, s.displayPath),
				h(
					"small",
					{},
					!f.base.exists
						? T("save.file.creates")
						: !text
							? T("save.file.removes")
							: [
									h("b", { style: { color: "var(--ok)" } }, "+" + added),
									" ",
									h("b", { style: { color: "var(--err)" } }, "−" + removed),
								],
				),
			),
			h(
				"div",
				{ class: "savegrid" },
				h(
					"div",
					{ style: { minWidth: 0 } },
					words.length > 0 &&
						h(
							"ul",
							{ class: "impact", style: { marginBottom: "8px" } },
							words.map(([ic, line]) => h("li", {}, icon(ic), h("span", {}, line))),
						),
					box,
				),
				h("div", { class: "checks" }, checks),
			),
		);
	});
	body.replaceChildren(...sections);
	note.textContent = blockers ? T("save.note.blocked") : T("save.note");
	go.disabled = blockers > 0;
	go.onclick = () => doSave(drafts, proofs, check, go, note);
}
async function doSave(drafts, proofs, check, go, note) {
	saving = true;
	go.disabled = true;
	go.textContent = T("save.going");
	const res = await api.save(
		drafts.map(({ s, sent }) => {
			const f = fileOf(s.id);
			return {
				sourceId: s.id,
				baseHash: f.base.exists ? f.base.hash : null,
				doc: sent,
				...(confirmedLoss.has(s.id + f.base.hash) && { confirmCanonicalRewrite: true }),
			};
		}),
	);
	saving = false;
	if (res.ok) {
		for (const snap of res.data.files ?? []) {
			const f = fileOf(snap.id);
			if (!f) continue;
			f.base = snap;
			f.theirs = null;
			for (const m of f.doc.mixtures) if (!isScratch(m)) m.$o = { sid: snap.id, name: m.name };
		}
		sources = res.data.sources ?? sources;
		confirmedLoss = new Set();
		for (const [s, proof] of proofs)
			proof.replaceChildren(check("ok", T("save.chk.proof"), T("save.chk.proved", { path: s.displayPath })));
		go.textContent = T("save.done");
		setTimeout(() => {
			closeSheet();
			sync();
			edited();
			render();
			toast(savedSummary(drafts.map(d => d.s)));
		}, 650);
		return;
	}
	go.textContent = T("save.go");
	if (res.status === 409 && res.data?.conflicts?.length) {
		for (const c of res.data.conflicts) if (fileOf(c.sourceId)) fileOf(c.sourceId).theirs = c.current;
		render();
		return openSave(); // the review now shows the conflict and the ways out
	}
	if (res.status === 500 && res.data?.partial) {
		sources = res.data.sources ?? sources;
		return partialSheet(res.data);
	}
	note.textContent = "";
	note.append(h("span", { style: { color: "var(--err)" } }, res.data?.error ?? T("save.failed")));
	go.disabled = false;
}
/* After a save: what the harness now does with each mixture that was written. */
function savedSummary(saved) {
	const names = [],
		hidden = [],
		cannot = [];
	for (const s of saved)
		for (const row of srcOf(s.id)?.mixtures ?? []) {
			if (row.status === "shadowed") hidden.push(row.name);
			else if (row.status === "invalid") cannot.push(row.name);
			else if (row.status === "registered") names.push(row.name);
		}
	return [
		TN("save.toast", saved.length),
		names.length && T("save.toast.roster", { names: names.map(n => "mixture/" + n).join(", ") }),
		hidden.length && T("save.toast.hidden", { names: hidden.join(", ") }),
		cannot.length && T("save.toast.cannot", { names: cannot.join(", ") }),
	]
		.filter(Boolean)
		.join(" ");
}
/* The rare bad case, said plainly: a write failed part-way and one file could not be put back. */
function partialSheet(data) {
	const word = { original: T("partial.original"), saved: T("partial.saved"), unknown: T("partial.unknown") };
	openSheet({
		title: T("partial.title"),
		sub: data.error,
		body: [
			h("p", { class: "hint", style: { marginBottom: "10px" } }, T("partial.body")),
			h(
				"ul",
				{ class: "impact" },
				(data.files ?? []).map(f =>
					h(
						"li",
						{},
						icon(f.state === "original" ? "check" : "warn"),
						h("span", {}, h("b", {}, srcOf(f.sourceId)?.displayPath ?? f.path), ": ", word[f.state] ?? f.state),
					),
				),
			),
		],
		note: T("partial.note"),
		cancel: T("partial.keep"),
		primary: {
			label: T("partial.reload"),
			run: async () => {
				closeSheet();
				await reloadAll(true);
			},
		},
	});
}

/* ═══════════════════════════ A FILE CHANGED ON DISK ═══════════════════════════ */
function conflictActions(s, after) {
	const f = fileOf(s.id);
	return h(
		"div",
		{ style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "7px" } },
		h("button", { class: "btn small", type: "button", onclick: () => theirChange(s) }, T("conflict.see")),
		h(
			"button",
			{
				class: "btn small",
				type: "button",
				onclick: () => {
					const both = mergeTheirs(s.id);
					after?.();
					toast(both.length ? T("conflict.merged.both", { names: both.join(", ") }) : T("conflict.merged"), {
						undo: true,
						bad: both.length > 0,
					});
				},
			},
			T("conflict.merge"),
		),
		h(
			"button",
			{
				class: "btn small danger",
				type: "button",
				onclick: () => {
					commit(T("act.discardFile", { path: s.displayPath }), () => {
						f.doc = adopt(f.theirs.doc, s.id);
						f.base = f.theirs;
						f.theirs = null;
						sync();
						if (!mix) pickMixture();
					});
					after?.();
				},
			},
			T("conflict.discard"),
		),
	);
}
function theirChange(s) {
	const f = fileOf(s.id),
		{ box, added, removed } = diffView(f.base.text ?? f.base.toml ?? "", f.theirs.text ?? f.theirs.toml ?? "");
	openSheet({
		wide: true,
		title: T("conflict.title"),
		sub: [
			s.displayPath,
			" · ",
			h("b", { style: { color: "var(--ok)" } }, "+" + added),
			" ",
			h("b", { style: { color: "var(--err)" } }, "−" + removed),
			" · ",
			T("conflict.title.sub"),
		],
		body: box,
		cancel: null,
		primary: { label: T("common.back"), run: () => openSave() },
		onClose: () => {},
	});
}
/* Take their version of everything I did not touch; keep mine where I did. Returns the names we both changed. */
function mergeTheirs(sid) {
	const f = fileOf(sid),
		base = f.base.doc,
		theirs = adopt(f.theirs.doc, sid),
		both = [];
	commit(
		T("act.mergeDisk"),
		() => {
			const mine = f.doc,
				baseBy = new Map((base.mixtures ?? []).map(m => [m.name, m])),
				theirsBy = new Map(theirs.mixtures.map(m => [m.name, m]));
			const keepName = cur?.sid === sid ? mix?.name : null,
				out = [];
			for (const m of mine.mixtures) {
				const origin = m.$o?.sid === sid ? m.$o.name : null;
				if (!origin) {
					out.push(m);
					continue;
				} // new here, or moved in: mine
				const was = baseBy.get(origin),
					now = theirsBy.get(origin);
				const iChanged = !was || structure(m) !== structure(was),
					theyChanged = !now || !was || structure(now) !== structure(was);
				if (!iChanged) {
					if (!now) continue; // they deleted something I had not touched
					for (const n of now.members) {
						const old = m.members.find(x => x.id === n.id);
						if (old) {
							n.$x = old.$x;
							n.$y = old.$y;
						}
					}
					out.push(now);
				} else {
					out.push(m);
					if (theyChanged) both.push(m.name);
				}
			}
			for (const m of theirs.mixtures) if (!baseBy.has(m.name) && !out.some(o => o.name === m.name)) out.push(m); // added on disk
			for (const kind of ["roles", "envelopes"]) {
				if (structure(mine[kind] ?? {}) === structure(base[kind] ?? {})) {
					theirs[kind] ? (mine[kind] = theirs[kind]) : delete mine[kind];
				} else if (structure(theirs[kind] ?? {}) !== structure(base[kind] ?? {}))
					both.push(kind === "roles" ? T("conflict.sharedRoles") : T("conflict.sharedEnvelopes"));
			}
			mine.mixtures = out;
			f.base = f.theirs;
			f.theirs = null;
			if (keepName !== null) {
				const at = out.findIndex(m => m.name === keepName);
				cur = at >= 0 ? { sid, index: at } : null;
				sel = null;
				sync();
				if (!mix) pickMixture();
			}
		},
		{ quiet: true },
	);
	return both;
}

/* ═══════════════════════════ KEEPING UP WITH DISK ═══════════════════════════
   The files can change under the page: another editor, a git checkout, the terminal UI. The page looks every few
   seconds and when its tab comes back. A file you have not touched is reloaded; one you have is flagged, never replaced. */
async function loadSource(sid) {
	const res = await api.source(sid);
	return res.ok ? res.data : null;
}
async function reloadAll(force) {
	const res = await api.sources();
	if (!res.ok) return false;
	const next = res.data.sources ?? [],
		reloaded = [];
	for (const s of next) {
		const f = fileOf(s.id),
			known = f?.theirs?.hash ?? f?.base.hash;
		if (f && !force && known === s.hash) continue;
		const snap = await loadSource(s.id);
		if (!snap) continue;
		if (!f || force || !fileDirty(s.id)) {
			const keepName = cur?.sid === s.id ? mix?.name : null,
				old = f?.doc;
			const fresh = adopt(snap.doc, s.id);
			for (const m of fresh.mixtures) {
				const was = old?.mixtures.find(x => x.name === m.name);
				for (const n of m.members) {
					const o = was?.members.find(x => x.id === n.id);
					if (o) {
						n.$x = o.$x;
						n.$y = o.$y;
					}
				}
			}
			if (old) for (const m of old.mixtures) if (isScratch(m)) fresh.mixtures.push(m);
			files.set(s.id, { base: snap, doc: fresh, theirs: null });
			if (keepName !== null) {
				const at = fresh.mixtures.findIndex(m => m.name === keepName);
				cur = at >= 0 ? { sid: s.id, index: at } : null;
			}
			if (f) reloaded.push(s.displayPath);
		} else f.theirs = snap;
	}
	for (const sid of [...files.keys()]) if (!next.some(s => s.id === sid) && !fileDirty(sid)) files.delete(sid);
	sources = next.filter(s => files.has(s.id));
	sync();
	if (!mix) pickMixture();
	if (reloaded.length || force) {
		undoStack.length = 0;
		redoStack.length = 0;
		edited();
		render();
		if (!camTouched) fit();
	} else {
		renderBar();
		if (sideOpen) renderSide();
		renderBanner();
	}
	if (reloaded.length && !force) toast(T("disk.reloaded", { paths: reloaded.join(", ") }));
	return true;
}
let watching = null;
function watchDisk() {
	const look = () => {
		if (document.visibilityState === "visible" && !saving && !gesture && !sheetEl) reloadAll(false);
	};
	watching = setInterval(look, 5000);
	addEventListener("focus", look);
	document.addEventListener("visibilitychange", look);
}
