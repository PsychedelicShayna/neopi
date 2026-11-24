"use strict";
/* Mixture Studio · save: validation by the harness, the Save review, and what happens when a file changed on disk.
   One Save writes every changed file in a single all-or-nothing request, so a move between two files cannot half-happen.
   Saving is the only thing here that touches disk, and it never overwrites a file that changed since it was loaded.
   Nothing somebody else wrote is ever dropped without the page saying so first. */

/* ═══════════════════════════ VALIDATION BY THE HARNESS ═══════════════════════════
   The page checks structure as you type. NeoPi checks everything it would check at registration (models resolve,
   templates compile, helpers exist), a moment after you stop typing. Its findings appear next to the page's own.
   An answer is about one exact draft of one file: `server.sid`, `server.key` and `server.mixes` say which. */
let draftTimer = null,
	disconnected = false;
function edited() {
	clearTimeout(draftTimer);
	if (!cur) {
		server = { seq: server.seq + 1, issues: [], reports: [], toml: null, map: [], mixes: [], pending: false };
		return;
	}
	server.pending = true;
	draftTimer = setTimeout(askHarness, 350);
}
async function askHarness() {
	if (!cur || disconnected) return;
	const seq = ++server.seq,
		sid = cur.sid,
		{ doc: sent, map } = sendable(sid),
		draft = fileOf(sid).doc;
	const mixes = map.map(i => draft.mixtures[i]),
		key = structure(sent);
	const res = await api.draft(sid, sent);
	if (seq !== server.seq) return; // a newer edit is already on its way
	if (!res.ok) {
		server.pending = false;
		server.failed = res.data?.error ?? T("harness.silent");
		soft();
		return;
	}
	const v = res.data.validation ?? {};
	server = {
		seq,
		pending: false,
		failed: null,
		sid,
		key,
		map,
		mixes,
		models: mixes.map(m => Object.fromEntries(m.members.map(n => [n.id, n.model]))),
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
/* What NeoPi resolved a member's selector to, if its answer is about this mixture and the selector that is still there. */
function harnessMember(id) {
	const at = server.mixes?.indexOf(mix) ?? -1;
	if (at < 0 || server.models?.[at]?.[id] !== node(id)?.model) return null;
	return server.reports.find(r => r.index === at)?.members?.[id] ?? null;
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
/* The order files are sent in: a file that takes a mixture from another comes before that other file.
   NeoPi does not depend on it. It writes any multi-file save in two phases inside one request: first every file
   gets its new content plus whatever it is losing, then the losses are removed. Stopped at any point, a moved
   mixture is in both files, never in none, and that holds for files that trade mixtures too. */
function saveOrder(list) {
	const ids = new Set(list.map(s => s.id)),
		takes = new Map(list.map(s => [s.id, new Set()]));
	for (const s of list)
		for (const m of fileOf(s.id).doc.mixtures)
			if (!isScratch(m) && m.$o && m.$o.sid !== s.id && ids.has(m.$o.sid)) takes.get(s.id).add(m.$o.sid);
	const state = new Map(),
		after = [];
	const visit = id => {
		if (state.has(id)) return;
		state.set(id, 1);
		for (const from of takes.get(id)) visit(from);
		after.push(id);
	};
	for (const s of list) visit(s.id);
	return after.reverse().map(srcOf);
}
/* NeoPi lets a definition it cannot run be written only when an identical copy on disk already could not run. */
const onDiskAsIs = m =>
	[...files.values()].some(f => (f.base.doc?.mixtures ?? []).some(b => structure(b) === structure(m)));
/* Leave the review for the exact thing that needs fixing: the mixture, the card or path, and the field. */
function jumpTo(sid, m, rest) {
	closeSheet();
	const index = fileOf(sid)?.doc.mixtures.indexOf(m) ?? -1;
	if (index < 0) return;
	if (cur?.sid !== sid || cur.index !== index) openMixture(sid, index, { keepSide: true });
	const at = locate(rest);
	if (at.kind !== "mix" || at.field) goIssue(at);
}
let saving = false,
	confirmedLoss = new Set(),
	saveSaid = null; // saveSaid: what NeoPi answered to the last refused save
/* What NeoPi refused at the moment of writing, per file, for as long as that draft stays exactly as it was sent. */
const refusals = new Map();
async function openSave() {
	if (saving) return;
	if (disconnected) return gone();
	if (trial) trialEnd();
	endConnect();
	pruneBad();
	const changed = saveOrder(dirtyFiles()),
		waiting = scratchList();
	if (!changed.length) {
		closeSheet();
		if (badInputs.size) {
			const b = [...badInputs.values()][0];
			return toast(T("save.onlyTypo", { label: b.label, text: b.text }), { bad: true });
		}
		return toast(
			waiting.length ? T("save.onlyScratch", { names: waiting.map(m => m.name).join(", ") }) : T("save.nothing"),
			{ bad: waiting.length > 0 },
		);
	}
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
			const { doc: sent, map } = sendable(s.id),
				d = fileOf(s.id).doc;
			return { s, sent, key: structure(sent), mixes: map.map(i => d.mixtures[i]), res: await api.draft(s.id, sent) };
		}),
	);
	if (sheetEl?.firstChild !== sheet) return; // closed while waiting
	if (drafts.some(d => !fileOf(d.s.id) || structure(sendable(d.s.id).doc) !== d.key)) return openSave(); // the draft moved on meanwhile
	let blockers = 0;
	const check = (state, title, sub, extra) =>
		h(
			"div",
			{ class: "check " + state },
			h("i", {}, icon(state === "ok" ? "check" : state === "no" ? "x" : state === "unk" ? "info" : "dots", 11)),
			h("span", {}, title, sub && h("small", {}, sub), extra),
		);
	const fixRow = (label, run) =>
		h("button", { class: "btn small fix", type: "button", onclick: run }, h("span", {}, label), icon("right", 12));
	const proofs = [],
		blockedFiles = new Set();
	const sections = drafts.map(({ s, sent, key, mixes, res }) => {
		const f = fileOf(s.id),
			refused = refusals.get(s.id)?.key === key ? refusals.get(s.id) : null;
		const text = res.ok ? (res.data.toml ?? "") : tomlOf(sent),
			before = f.base.text ?? f.base.toml ?? "";
		const { box, added, removed } = diffView(before, text),
			checks = [],
			block = () => {
				blockers++;
				blockedFiles.add(s.id);
			};
		if (!res.ok) {
			block();
			checks.push(check("no", T("save.chk.unreachable"), res.data?.error ?? T("harness.silent")));
		} else {
			const errs = (refused?.errors ?? res.data.validation?.errors ?? []).map(it => {
				const m = /^mixtures\[(\d+)\]\.?(.*)$/.exec(it.path ?? ""),
					target = m ? (mixes[+m[1]] ?? null) : null;
				return { it, rest: m?.[2] ?? "", target, blocks: !target || !onDiskAsIs(target) };
			});
			let blocking = errs.filter(e => e.blocks);
			if (refused?.blocked && !blocking.length) blocking = errs;
			const carried = new Set(errs.filter(e => !blocking.includes(e)).map(e => e.target.name));
			const lossy = refused?.diagnostics ?? res.data.parseDiagnostics ?? [];
			if (blocking.length || lossy.length || refused?.blocked) {
				block();
				checks.push(
					check(
						"no",
						refused ? T("save.chk.refused") : TN("save.chk.errors", blocking.length + lossy.length),
						refused
							? blocking.length || lossy.length
								? T("save.chk.refused.sub")
								: (refused.error ?? T("save.failed"))
							: T("save.chk.errors.sub"),
						h(
							"div",
							{ class: "fixes" },
							lossy.map(line => h("div", { class: "hint" }, line)),
							blocking
								.slice(0, 8)
								.map(({ it, rest, target }) =>
									target
										? fixRow([h("b", {}, target.name), " ", it.message], () => jumpTo(s.id, target, rest))
										: h("div", { class: "hint" }, it.message),
								),
							blocking.length > 8 && h("div", { class: "hint" }, T("save.chk.more", { n: blocking.length - 8 })),
						),
					),
				);
			} else checks.push(check("ok", T("save.chk.valid"), T("save.chk.valid.sub")));
			if (carried.size)
				checks.push(
					check("unk", T("save.chk.carried", { names: [...carried].join(", ") }), T("save.chk.carried.sub")),
				);
		}
		const typos = [...badInputs.values()].filter(b => f.doc.mixtures.includes(b.mix));
		if (typos.length) {
			block();
			checks.push(
				check(
					"no",
					T("save.chk.typos"),
					T("save.chk.typos.sub"),
					h(
						"div",
						{ class: "fixes" },
						typos.map(b =>
							fixRow([h("b", {}, b.mix.name), " ", b.label, ": “", b.text, "”"], () => {
								closeSheet();
								const at = f.doc.mixtures.indexOf(b.mix);
								if (cur?.sid !== s.id || cur.index !== at) openMixture(s.id, at, { keepSide: true });
								goIssue({ kind: b.kind, id: b.id, field: b.field });
							}),
						),
					),
				),
			);
		}
		const now = srcOf(s.id) ?? s;
		const copyMine = () =>
			h(
				"div",
				{ class: "fixes row" },
				h(
					"button",
					{
						class: "btn small",
						type: "button",
						onclick: () => copyText(tomlOf(sent), T("gone.copied", { path: s.displayPath })),
					},
					icon("copy", 12),
					T("save.copyMine"),
				),
			);
		/* A file NeoPi cannot read any more is not something to merge with: nothing is written to it, and the draft waits. */
		if (f.theirs?.broken) {
			block();
			checks.push(check("no", T("save.chk.broken"), T("save.chk.broken.sub", { why: f.theirs.broken }), copyMine()));
		} else if (!writable(now)) {
			block();
			checks.push(
				check(
					"no",
					T("save.chk.readOnly"),
					T("save.chk.readOnly.sub", { why: now.readOnly ?? f.base.broken ?? "?" }),
					copyMine(),
				),
			);
		} else if (f.theirs) {
			block();
			checks.push(check("no", T("save.chk.conflict"), T("save.chk.conflict.sub"), conflictActions(s)));
		} else
			checks.push(
				check(
					"ok",
					f.base.exists ? T("save.chk.fresh") : T("save.chk.absent"),
					f.base.exists ? T("save.chk.fresh.sub") : T("save.chk.absent.sub"),
				),
			);
		if (f.both?.length && !f.theirs)
			checks.push(
				check(
					"unk",
					T("save.chk.both"),
					T("save.chk.both.sub"),
					h(
						"div",
						{ class: "fixes" },
						f.both.map(line => h("div", { class: "hint" }, line)),
					),
				),
			);
		const losing = f.base.parseDiagnostics ?? [];
		if (losing.length && !f.theirs) {
			const agreed = confirmedLoss.has(s.id + f.base.hash);
			if (!agreed) block();
			checks.push(
				check(
					agreed ? "unk" : "no",
					T("save.chk.lossy"),
					null,
					h(
						"div",
						{ class: "fixes" },
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
		const counts = !f.base.exists
			? T("save.file.creates")
			: !text
				? T("save.file.removes")
				: [
						h("b", { style: { color: "var(--ok)" } }, "+" + added),
						" ",
						h("b", { style: { color: "var(--err)" } }, "−" + removed),
					];
		const section = h(
			"section",
			{},
			h(
				"div",
				{ class: "filehead" },
				h("span", { class: cls("tag", s.kind === "user" ? "judge" : "local") }, scopeLabel(s)),
				h("span", { title: s.path }, s.displayPath),
				h("small", {}, counts),
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
		return {
			s,
			section,
			words,
			counts: !f.base.exists
				? T("save.file.creates")
				: !text
					? T("save.file.removes.short")
					: `+${added} −${removed}`,
		};
	});
	/* With several files, the first thing in the review is the list of them: nothing that will be written is below the fold unannounced. */
	const index =
		sections.length > 1 &&
		h(
			"div",
			{ class: "saveindex" },
			sections.map(({ s, section, words, counts }) =>
				h(
					"button",
					{
						type: "button",
						class: cls(blockedFiles.has(s.id) && "no"),
						onclick: () => section.scrollIntoView({ block: "start", behavior: "smooth" }),
					},
					h("span", { class: cls("tag", s.kind === "user" ? "judge" : "local") }, scopeLabel(s)),
					h("b", {}, s.displayPath),
					h(
						"span",
						{},
						words
							.map(([, line]) =>
								[line]
									.flat(Infinity)
									.map(x => x.textContent ?? x)
									.join(""),
							)
							.join(" "),
					),
					h("small", {}, counts),
				),
			),
		);
	const idle = waiting.filter(m => !changed.some(s => fileOf(s.id).doc.mixtures.includes(m)));
	body.replaceChildren(
		...[
			index,
			...sections.map(x => x.section),
			idle.length > 0 &&
				h(
					"p",
					{ class: "hint", style: { marginTop: "12px" } },
					T("save.scratchNote", { names: idle.map(m => m.name).join(", ") }),
				),
		].filter(Boolean),
	);
	const said = saveSaid;
	saveSaid = null;
	note.textContent = blockers ? T("save.note.blocked") : T("save.note");
	if (said) note.replaceChildren(h("span", { style: { color: "var(--err)" } }, said));
	go.disabled = blockers > 0;
	go.onclick = () => doSave(drafts, proofs, check, go, note);
	if (!blockers) go.focus();
}
/* What a successful write means for the page: the files on disk are now these, and what was written is at home there. */
function settle(data) {
	for (const snap of data.files ?? []) {
		const f = fileOf(snap.id);
		if (!f) continue;
		/* Older undo steps were drafts against the disk as it was before this save. This save put my own draft there,
       so going back to them is going back on my own work: they now compare against what was just written. */
		for (const step of [...undoStack, ...redoStack]) {
			const then = step.state.disk.get(snap.id);
			if (then && sameDisk(then.base, f.base)) then.base = snap;
		}
		f.base = snap;
		f.theirs = null;
		f.both = null;
		for (const m of f.doc.mixtures) if (!isScratch(m)) m.$o = { sid: snap.id, name: m.name };
	}
	sources = data.sources ?? sources;
	reconcileOrigins();
}
async function doSave(drafts, proofs, check, go, note) {
	saving = true;
	go.disabled = true;
	go.textContent = T("save.going");
	const list = drafts.map(d => d.s);
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
		settle(res.data);
		confirmedLoss = new Set();
		refusals.clear();
		for (const [s, proof] of proofs)
			proof.replaceChildren(check("ok", T("save.chk.proof"), T("save.chk.proved", { path: s.displayPath })));
		go.textContent = T("save.done");
		setTimeout(() => {
			closeSheet();
			sync();
			edited();
			render();
			toast(savedSummary(list));
		}, 650);
		return;
	}
	go.textContent = T("save.go");
	if (res.status === 410) return;
	if (res.status === 409 && res.data?.conflicts?.length) {
		for (const c of res.data.conflicts) if (fileOf(c.sourceId)) fileOf(c.sourceId).theirs = c.current;
		render();
		return openSave(); // the review now shows the conflict and the ways out
	}
	/* Refused for a reason about the file itself. The page looks at the files again, so the review can say what is
     the matter and what to do, next to NeoPi's own words. */
	if (res.status === 409 && res.data?.code) {
		if (res.data.code === "rewrite-loses-source")
			for (const r of res.data.files ?? []) {
				const f = fileOf(r.sourceId);
				if (f) f.base = { ...f.base, parseDiagnostics: r.parseDiagnostics ?? [] };
			}
		else await reloadAll(false);
		saveSaid = res.data.error ?? null;
		return openSave();
	}
	if (res.status === 422 && res.data?.files?.length) {
		for (const r of res.data.files) {
			const d = drafts.find(x => x.s.id === r.sourceId);
			if (d)
				refusals.set(r.sourceId, {
					key: d.key,
					blocked: r.blocked !== false,
					errors: r.validation?.errors ?? [],
					diagnostics: r.parseDiagnostics ?? [],
					error: res.data.error,
				});
		}
		return openSave(); // the review now names what was refused, and where
	}
	if (res.status === 500 && res.data?.partial) {
		sources = res.data.sources ?? sources;
		return partialSheet(res.data);
	}
	render();
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
/* The rare bad case, said plainly: a write failed part-way and one file could not be put back.
   The safe choice is the default: the draft stays. Reloading is offered, says what it does, and can be undone. */
function partialSheet(data) {
	const word = {
		original: T("partial.original"),
		saved: T("partial.saved"),
		staged: T("partial.staged"),
		unknown: T("partial.unknown"),
	};
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
		cancel: null,
		extra: [
			h(
				"button",
				{
					class: "btn",
					type: "button",
					title: T("partial.reload.title"),
					onclick: async () => {
						closeSheet();
						if (await reloadAll(true)) toast(T("partial.reloaded"), { undo: true });
					},
				},
				T("partial.reload"),
			),
		],
		primary: {
			label: T("partial.keep"),
			run: async () => {
				closeSheet();
				await reloadAll(false);
			},
		},
	});
}

/* ═══════════════════════════ A FILE CHANGED ON DISK ═══════════════════════════
   Three ways out, all undoable, and none of them loses anything quietly:
   see their change · bring it into my draft (three-way, mixture by mixture) · drop my changes to this file.
   A move is one change to two files, so both ways out treat its two halves together. */
function conflictActions(s) {
	return h(
		"div",
		{ class: "fixes row" },
		h("button", { class: "btn small", type: "button", onclick: () => theirChange(s) }, T("conflict.see")),
		h(
			"button",
			{
				class: "btn small",
				type: "button",
				onclick: () => {
					const notes = mergeTheirs(s.id);
					afterConflict();
					toast(notes.length ? T("conflict.merged.notes", { n: notes.length }) : T("conflict.merged"), {
						undo: true,
						bad: notes.length > 0,
					});
				},
			},
			T("conflict.merge"),
		),
		h("button", { class: "btn small danger", type: "button", onclick: () => confirmDrop(s) }, T("conflict.discard")),
	);
}
/* Back to the review while something is left to save; otherwise it has nothing more to say. */
function afterConflict() {
	if (dirty()) return openSave();
	closeSheet();
}
function theirChange(s) {
	const f = fileOf(s.id);
	if (!f?.theirs) return afterConflict();
	const { box, added, removed } = diffView(f.base.text ?? f.base.toml ?? "", f.theirs.text ?? f.theirs.toml ?? "");
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
		primary: { label: T("common.back"), run: afterConflict },
		onClose: afterConflict,
	});
}
/* Every draft mixture that came from this file, wherever it is now: name on disk → {m, at}. */
function fromHere(sid) {
	const out = new Map();
	for (const [at, f] of files) for (const m of f.doc.mixtures) if (m.$o?.sid === sid) out.set(m.$o.name, { m, at });
	return out;
}
/* Is a mixture I moved away still exactly the original? Its name may differ, and it may carry copies of presets it
   read from its old file; anything else, including a preset I wrote or changed on it, makes it an edited copy. */
function untouchedSince(m, original, homeDoc) {
	const plain = { ...m, name: original.name };
	for (const kind of ["roles", "envelopes"]) {
		const kept = Object.fromEntries(
			Object.entries(m[kind] ?? {}).filter(
				([key, text]) =>
					own(original[kind], key) ||
					(own(homeDoc[kind], key) ? homeDoc[kind][key] : boot.bundled[kind]?.[key]) !== text,
			),
		);
		Object.keys(kept).length ? (plain[kind] = kept) : delete plain[kind];
	}
	return structure(plain) === structure(original);
}
/* Take their version of everything I did not touch, keep mine where I did, and keep theirs too wherever dropping it
   would lose something they wrote. Returns notes, one per thing worth a look; the Save review shows them. */
function mergeTheirs(sid) {
	if (!fileOf(sid)?.theirs || fileOf(sid).theirs.broken) return [];
	const f = fileOf(sid),
		base = f.base.doc ?? {},
		theirs = adopt(f.theirs.doc, sid),
		notes = [],
		open = mix,
		path = srcOf(sid).displayPath;
	commit(
		T("act.mergeDisk"),
		() => {
			const mine = f.doc,
				was = new Map((base.mixtures ?? []).map(m => [m.name, m])),
				now = new Map(theirs.mixtures.map(m => [m.name, m])),
				here = fromHere(sid),
				out = [];
			const keepPlace = (to, from) => {
				for (const n of to.members) {
					const o = from.members.find(x => x.id === n.id);
					if (o) {
						n.$x = o.$x;
						n.$y = o.$y;
					}
				}
				return to;
			};
			/* Their mixture keeps its name: it is the one on disk. A draft mixture of mine in the way gets a new one. */
			const place = t => {
				const clash = out.find(m => m.name === t.name);
				if (clash) {
					const taken = new Set([...out, ...theirs.mixtures].map(m => m.name)),
						to = freeId(t.name + "-", taken);
					notes.push(T("conflict.note.name", { name: t.name, to }));
					clash.name = to;
				}
				out.push(t);
			};
			for (const m of mine.mixtures) {
				const origin = m.$o?.sid === sid ? m.$o.name : null,
					b = origin != null ? was.get(origin) : null,
					t = origin != null ? now.get(origin) : null;
				if (!b) {
					out.push(m);
					continue;
				} // new here, moved in, or not written yet: mine
				const iChanged = structure(m) !== structure(b),
					theyChanged = !t || structure(t) !== structure(b);
				if (!iChanged) {
					if (t) out.push(keepPlace(t, m));
					continue;
				} // untouched by me: theirs, including their delete
				out.push(m);
				if (theyChanged)
					notes.push(
						t ? T("conflict.note.both", { name: m.name }) : T("conflict.note.theyDeleted", { name: m.name }),
					);
			}
			for (const [name, b] of was) {
				// what I deleted or moved away
				if (mine.mixtures.some(m => m.$o?.sid === sid && m.$o.name === name)) continue;
				const t = now.get(name),
					moved = here.get(name);
				if (!t || structure(t) === structure(b)) continue; // they left it alone (my delete or move stands), or deleted it too
				place(t); // they changed it: their version stays where it is
				notes.push(
					moved
						? T("conflict.note.moved", { name, path, dest: srcOf(moved.at)?.displayPath ?? "?" })
						: T("conflict.note.deleted", { name }),
				);
			}
			for (const t of theirs.mixtures) {
				// what they added
				if (was.has(t.name)) continue;
				const twin = out.find(m => m.name === t.name && structure(m) === structure(t));
				if (twin) out[out.indexOf(twin)] = keepPlace(t, twin);
				else place(t);
			}
			for (const kind of ["roles", "envelopes"]) {
				// shared presets, key by key
				const b = base[kind] ?? {},
					t = theirs[kind] ?? {},
					m = mine[kind] ?? {},
					next = {};
				for (const key of new Set([...Object.keys(t), ...Object.keys(m)])) {
					if (m[key] === b[key]) {
						if (t[key] !== undefined) next[key] = t[key];
						continue;
					}
					if (m[key] !== undefined) next[key] = m[key];
					if (t[key] !== b[key] && t[key] !== m[key]) notes.push(T("conflict.note.preset", { name: key }));
				}
				Object.keys(next).length ? (mine[kind] = next) : delete mine[kind];
			}
			mine.mixtures = out;
			f.base = f.theirs;
			f.theirs = null;
			f.both = notes.length ? notes : null;
			reconcileOrigins();
			reopen(open, sid, open?.name);
		},
		{ quiet: true },
	);
	return notes;
}
/* What dropping my changes to one file does: in words for the confirmation, and as the steps that do it. */
function dropPlan(sid) {
	const f = fileOf(sid),
		disk = f.theirs ?? f.base,
		onDisk = new Map((disk.doc?.mixtures ?? []).map(m => [m.name, m])),
		lines = [],
		steps = [];
	for (const m of f.doc.mixtures) {
		if (isScratch(m)) continue;
		if (m.$o && m.$o.sid !== sid) {
			// moved in from another file: the move is undone, it goes home
			const home = fileOf(m.$o.sid),
				homeSrc = srcOf(m.$o.sid),
				was = m.$o.name;
			lines.push(["left", TX("drop.back", { name: was, path: homeSrc?.displayPath ?? "?" })]);
			steps.push(() => {
				const original = (home.base.doc?.mixtures ?? []).find(x => x.name === was),
					at = (home.base.doc?.mixtures ?? []).indexOf(original);
				for (const kind of ["roles", "envelopes"]) {
					// the copies of presets it took along are not needed at home
					for (const key of Object.keys(m[kind] ?? {}))
						if (
							!own(original?.[kind], key) &&
							(own(home.doc[kind], key) ? home.doc[kind][key] : boot.bundled[kind]?.[key]) === m[kind][key]
						)
							delete m[kind][key];
					if (m[kind] && !Object.keys(m[kind]).length) delete m[kind];
				}
				m.name = home.doc.mixtures.some(x => x.name === was) ? freeName(m.$o.sid, was) : was;
				home.doc.mixtures.splice(Math.min(Math.max(at, 0), home.doc.mixtures.length), 0, m);
			});
		} else if (!m.$o) lines.push(["trash", TX("drop.new", { name: m.name })]);
		else if (mixState(m, sid)) lines.push(["undo", TX("drop.edits", { name: m.$o.name })]);
	}
	for (const [name, { m, at }] of fromHere(sid)) {
		// moved out to another file
		if (at === sid) continue;
		const original = (f.base.doc?.mixtures ?? []).find(x => x.name === name),
			dest = srcOf(at)?.displayPath ?? "?";
		if (!onDisk.has(name)) {
			lines.push(["info", TX("drop.movedGone", { name, dest })]);
			continue;
		}
		if (original && untouchedSince(m, original, f.doc)) {
			lines.push(["left", TX("drop.movedBack", { name, dest })]);
			steps.push(() => {
				const d = fileOf(at).doc;
				d.mixtures.splice(d.mixtures.indexOf(m), 1);
			});
		} else lines.push(["dup", TX("drop.movedCopy", { name, dest })]);
	}
	const here = fromHere(sid);
	for (const m of f.base.doc?.mixtures ?? [])
		if (!here.has(m.name) && onDisk.has(m.name)) lines.push(["undo", TX("drop.undelete", { name: m.name })]);
	if (
		structure(f.doc.roles ?? {}) !== structure(f.base.doc?.roles ?? {}) ||
		structure(f.doc.envelopes ?? {}) !== structure(f.base.doc?.envelopes ?? {})
	)
		lines.push(["layers", T("drop.presets")]);
	return {
		lines,
		run() {
			for (const step of steps) step();
			follow(sid, disk);
		},
	};
}
function confirmDrop(s) {
	const plan = dropPlan(s.id),
		open = mix;
	openSheet({
		title: T("drop.title", { path: s.displayPath }),
		sub: T("drop.sub"),
		body: plan.lines.length
			? h(
					"ul",
					{ class: "impact" },
					plan.lines.map(([ic, line]) => h("li", {}, icon(ic), h("span", {}, line))),
				)
			: h("p", { class: "hint" }, T("drop.none")),
		note: T("delete.note"),
		onClose: afterConflict,
		primary: {
			label: T("drop.go"),
			danger: true,
			run: () => {
				commit(
					T("act.discardFile", { path: s.displayPath }),
					() => {
						plan.run();
						reconcileOrigins();
						reopen(open, cur?.sid, open?.name);
					},
					{ quiet: true },
				);
				if (!camTouched) fit();
				afterConflict();
				toast(dirty() ? T("drop.done.more") : T("drop.done"), { undo: true });
			},
		},
	});
}

/* ═══════════════════════════ KEEPING UP WITH DISK ═══════════════════════════
   The files can change under the page: another editor, a git checkout, the terminal UI. The page looks every few
   seconds and when its tab comes back. A file you have not touched follows the disk; one you have is flagged, never
   replaced. Undo history is kept: each step remembers which version of the disk it was written against. */
async function loadSource(sid) {
	const res = await api.source(sid);
	return res.ok ? res.data : null;
}
async function reloadAll(force) {
	if (disconnected) return false;
	const res = await api.sources();
	if (!res.ok) return false;
	const next = res.data.sources ?? [],
		fresh = [];
	for (const s of next) {
		const f = fileOf(s.id),
			known = f && (f.theirs ?? f.base);
		if (f && !force && sameDisk(known, s)) continue;
		const snap = await loadSource(s.id);
		if (snap) fresh.push([s, snap]);
	}
	const gone2 = [...files.keys()].filter(sid => !next.some(s => s.id === sid) && !fileDirty(sid));
	const listed = JSON.stringify(next) !== JSON.stringify(sources);
	if (!fresh.length && !gone2.length && !listed) return true; // nothing moved: nothing on screen is touched
	const open = mix,
		openSid = cur?.sid,
		openName = mix?.name,
		reloaded = [];
	let replacedOpen = false;
	const apply = () => {
		for (const [s, snap] of fresh) {
			const f = fileOf(s.id);
			if (!f || force) {
				follow(s.id, snap);
				if (f) reloaded.push(s.displayPath);
				if (s.id === openSid) replacedOpen = true;
			} /* The disk holds exactly my draft (a save that stopped part-way wrote it, or only comments changed): nothing
         to decide. The draft stays as it is, with what it knows about mixtures still moving in, on the new version. */ else if (
				sameAsDisk(s.id, snap)
			) {
				f.base = snap;
				f.theirs = null;
				f.both = null;
			} else if (!fileDirty(s.id)) {
				follow(s.id, snap);
				reloaded.push(s.displayPath);
				if (s.id === openSid) replacedOpen = true;
			} else if (!snap.broken && sameDisk(snap, f.base))
				f.theirs = null; // back to the version this draft was written against
			else f.theirs = snap;
		}
		for (const sid of gone2) {
			files.delete(sid);
			if (sid === openSid) replacedOpen = true;
		}
		sources = [
			...next.filter(s => files.has(s.id)),
			...sources.filter(s => !next.some(n => n.id === s.id) && files.has(s.id)),
		];
		reconcileOrigins();
		reopen(open, openSid, openName);
	};
	if (force) commit(T("act.reload"), apply, { quiet: true });
	else apply();
	if (reloaded.length || gone2.length) {
		closePop(); // a menu opened on the old list would act on the wrong rows
		if (sideRename && !whereIs(sideRename.m)) sideRename = null;
	}
	if (force) {
		if (!camTouched) fit();
		return true;
	}
	if (replacedOpen) {
		edited();
		render();
		if (!camTouched) fit();
	} else {
		renderBar();
		renderSide();
		renderBanner();
	}
	if (reloaded.length) toast(T("disk.reloaded", { paths: reloaded.join(", ") }));
	return true;
}
let watching = null;
function watchDisk() {
	const look = () => {
		if (
			document.visibilityState === "visible" &&
			!saving &&
			!gesture &&
			!connect &&
			!sheetEl &&
			!document.querySelector(".nid-edit")
		)
			reloadAll(false);
	};
	watching = setInterval(look, 5000);
	addEventListener("focus", look);
	document.addEventListener("visibilitychange", look);
}
