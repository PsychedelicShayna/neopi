/** Bounded, receipt-owned accounting for alert-queue overflow. The caller owns replay references. */
export type OverflowClass = "L" | "M" | "H" | "E" | "X";
export type OverflowCategory = "known" | "unknown";
export interface OverflowObservation {
	token: string;
	fingerprint: string;
	observationRevision: number;
	category: OverflowCategory;
	slug?: string;
	letter?: OverflowClass;
	/** True while the active ledger or any bounded replay capture retains this token. */
	replayable?: boolean;
}
export interface OverflowEpochs {
	call: number;
	source: number;
	alert: number;
}
interface Contribution {
	category: OverflowCategory;
	slug?: string;
	letter?: OverflowClass;
	nonLowBase: boolean;
	firstSeq: number;
}
interface Marker {
	fingerprint: string;
	observationRevision: number;
	replayable: boolean;
	contribution: Contribution;
}
interface CohortMember extends Marker {
	frozenFingerprint: string;
	pendingChangedSelection?: OverflowObservation;
}
interface Representative {
	token: string;
	slug: string;
	letter: OverflowClass;
	firstSeq: number;
	nonLowBase: boolean;
}
interface Bucket {
	count: number;
	representative?: Representative;
	hasNonLowBase: boolean;
}
type Buckets = Record<OverflowClass, Bucket>;
interface Burst {
	id: number;
	firstAt: number;
	policyGeneration: number;
	policyRevision: number;
	retiredUnknownCount: number;
	retiredByClass: Buckets;
	live: Map<string, Marker>;
	mixed: boolean;
}
interface Receipt {
	id: number;
	epochs: OverflowEpochs;
	burst: Burst;
	cohort: Map<string, CohortMember>;
	text: string;
}
const letters: OverflowClass[] = ["L", "M", "H", "E", "X"];
const lowBase = (slug: string) => /luna|haiku|glm/i.test(slug);
const buckets = (): Buckets => ({
	L: { count: 0, hasNonLowBase: false },
	M: { count: 0, hasNonLowBase: false },
	H: { count: 0, hasNonLowBase: false },
	E: { count: 0, hasNonLowBase: false },
	X: { count: 0, hasNonLowBase: false },
});
function better(a: Representative, b?: Representative): boolean {
	return (
		!b ||
		(a.nonLowBase !== b.nonLowBase
			? a.nonLowBase
			: a.firstSeq !== b.firstSeq
				? a.firstSeq < b.firstSeq
				: a.token < b.token)
	);
}
function contribution(observation: OverflowObservation, seq: number): Contribution {
	if (observation.category === "known" && observation.slug && observation.letter)
		return {
			category: "known",
			slug: observation.slug,
			letter: observation.letter,
			nonLowBase: !lowBase(observation.slug),
			firstSeq: seq,
		};
	return { category: "unknown", nonLowBase: false, firstSeq: seq };
}
function neutral(c: Contribution): Contribution {
	return { category: "unknown", nonLowBase: false, firstSeq: c.firstSeq };
}
function retire(burst: Burst, token: string, c: Contribution): void {
	if (c.category === "unknown" || !c.letter || !c.slug) {
		burst.retiredUnknownCount++;
		return;
	}
	const bucket = burst.retiredByClass[c.letter];
	bucket.count++;
	bucket.hasNonLowBase ||= c.nonLowBase;
	const candidate: Representative = {
		token,
		slug: c.slug,
		letter: c.letter,
		firstSeq: c.firstSeq,
		nonLowBase: c.nonLowBase,
	};
	if (better(candidate, bucket.representative)) bucket.representative = candidate;
}
function newBurst(id: number, at: number, generation: number, revision: number): Burst {
	return {
		id,
		firstAt: at,
		policyGeneration: generation,
		policyRevision: revision,
		retiredUnknownCount: 0,
		retiredByClass: buckets(),
		live: new Map(),
		mixed: false,
	};
}
function total(burst: Burst): number {
	return (
		burst.retiredUnknownCount +
		letters.reduce((n, letter) => n + burst.retiredByClass[letter].count, 0) +
		burst.live.size
	);
}
function overview(burst: Burst): {
	known: number;
	unknown: number;
	representative?: Representative;
	hasNonLowBaseX: boolean;
} {
	let unknown = burst.retiredUnknownCount;
	let known = 0;
	let representative: Representative | undefined;
	let hasNonLowBaseX = burst.retiredByClass.X.hasNonLowBase;
	for (const letter of letters) {
		const bucket = burst.retiredByClass[letter];
		known += bucket.count;
		const candidate = bucket.representative;
		if (
			candidate &&
			(!representative ||
				letters.indexOf(candidate.letter) > letters.indexOf(representative.letter) ||
				(candidate.letter === representative.letter && better(candidate, representative)))
		)
			representative = candidate;
	}
	for (const [token, marker] of burst.live) {
		const c = marker.contribution;
		if (c.category === "unknown" || !c.letter || !c.slug) {
			unknown++;
			continue;
		}
		known++;
		if (c.letter === "X") hasNonLowBaseX ||= c.nonLowBase;
		const candidate: Representative = {
			token,
			slug: c.slug,
			letter: c.letter,
			firstSeq: c.firstSeq,
			nonLowBase: c.nonLowBase,
		};
		if (
			!representative ||
			letters.indexOf(candidate.letter) > letters.indexOf(representative.letter) ||
			(candidate.letter === representative.letter && better(candidate, representative))
		)
			representative = candidate;
	}
	return { known, unknown, representative, hasNonLowBaseX };
}
function line(burst: Burst): string {
	const { known, unknown, representative, hasNonLowBaseX } = overview(burst);
	if (!known || !representative)
		return `Attention: ${known + unknown} deployments' catalog status and authorization not checked.`;
	const prefix = known >= 10 || hasNonLowBaseX ? "A tidal wave of" : "A surge of";
	const suffix = unknown ? ` ${unknown} other deployments' catalog status and authorization not checked.` : "";
	const end = `, exceeded the alert queue; authorization not checked.${suffix}`;
	const start = `Red alert: ${prefix} ${known} deployments, including class ${representative.letter}`;
	const slug = ` ${representative.slug}`;
	const candidate = start + slug + end;
	if (Buffer.byteLength(candidate, "utf8") <= 500) return candidate;
	return start + end;
}
function sameEpoch(a: OverflowEpochs, b: OverflowEpochs): boolean {
	return a.call === b.call && a.source === b.source && a.alert === b.alert;
}

export class LiveIngestOverflow {
	readonly #now: () => number;
	#nextBurst = 1;
	#nextReceipt = 1;
	#nextSequence = 1;
	#generation = 0;
	#revision = 0;
	#unrendered: Burst;
	#receipt?: Receipt;
	readonly #inactive = new Map<string, true>();
	readonly #seen = new Map<string, { fingerprint: string; observationRevision: number }>();
	constructor(now: () => number = Date.now) {
		this.#now = now;
		this.#unrendered = newBurst(this.#nextBurst++, now(), 0, 0);
	}
	get hasPending(): boolean {
		return total(this.#unrendered) > 0;
	}
	get hasReceipt(): boolean {
		return !!this.#receipt;
	}
	get firstPendingAt(): number | undefined {
		return this.hasPending ? this.#unrendered.firstAt : undefined;
	}
	get stats() {
		const current = overview(this.#unrendered);
		return {
			knownCount: current.known,
			unknownCount: current.unknown,
			retiredUnknownCount: this.#unrendered.retiredUnknownCount,
			retiredByClass: structuredClone(this.#unrendered.retiredByClass),
			representative: current.representative,
			hasNonLowBaseX: current.hasNonLowBaseX,
			liveMarkers: this.#unrendered.live.size + this.#seen.size,
			receiptCohort: this.#receipt?.cohort.size ?? 0,
			contributors: this.#unrendered.live.size + (this.#receipt?.cohort.size ?? 0),
			count: total(this.#unrendered),
			frozenCount: this.#receipt ? total(this.#receipt.burst) : 0,
			inactiveDedupe: this.#inactive.size,
			mixed: this.#unrendered.mixed,
		};
	}
	#remember(token: string): void {
		this.#inactive.delete(token);
		this.#inactive.set(token, true);
		if (this.#inactive.size > 256) this.#inactive.delete(this.#inactive.keys().next().value!);
	}
	#assign(burst: Burst, observation: OverflowObservation, old?: Marker): void {
		const c = contribution(observation, old?.contribution.firstSeq ?? this.#nextSequence++);
		if (!old && burst.live.size + this.#seen.size >= 712) {
			retire(burst, observation.token, c);
			this.#remember(observation.token);
		} else
			burst.live.set(observation.token, {
				fingerprint: observation.fingerprint,
				observationRevision: observation.observationRevision,
				replayable: observation.replayable ?? old?.replayable ?? true,
				contribution: c,
			});
		burst.mixed ||= total(burst) > 1 || !!old;
	}
	observe(observation: OverflowObservation): void {
		const cohort = this.#receipt?.cohort.get(observation.token);
		if (cohort) {
			if (observation.observationRevision < cohort.observationRevision) return;
			if (observation.replayable !== undefined) cohort.replayable = observation.replayable;
			if (observation.fingerprint !== cohort.fingerprint) {
				cohort.fingerprint = observation.fingerprint;
				cohort.pendingChangedSelection = observation;
			} else if (cohort.pendingChangedSelection) cohort.pendingChangedSelection = observation;
			cohort.observationRevision = observation.observationRevision;
			return;
		}
		const seen = this.#seen.get(observation.token);
		if (seen) {
			if (observation.observationRevision < seen.observationRevision) return;
			if (seen.fingerprint !== observation.fingerprint) {
				this.#seen.delete(observation.token);
				this.count(observation);
			} else seen.observationRevision = observation.observationRevision;
			return;
		}
		const marker = this.#unrendered.live.get(observation.token);
		if (!marker || observation.observationRevision < marker.observationRevision) return;
		if (observation.replayable !== undefined) marker.replayable = observation.replayable;
		if (
			observation.fingerprint !== marker.fingerprint ||
			(marker.contribution.category === "unknown" && observation.category === "known")
		) {
			this.#assign(this.#unrendered, observation, marker);
		} else marker.observationRevision = observation.observationRevision;
	}
	count(observation: OverflowObservation): void {
		const cohort = this.#receipt?.cohort.get(observation.token);
		if (cohort) {
			this.observe(observation);
			return;
		}
		const marker = this.#unrendered.live.get(observation.token);
		if (marker) {
			this.observe(observation);
			return;
		}
		if (this.#seen.has(observation.token)) {
			this.observe(observation);
			return;
		}
		if (this.#inactive.has(observation.token)) return;
		if (!this.hasPending) this.#unrendered.firstAt = this.#now();
		this.#assign(this.#unrendered, observation);
		if (observation.replayable === false) this.setReplayable(observation.token, false);
	}
	setReplayable(token: string, replayable: boolean): void {
		const cohort = this.#receipt?.cohort.get(token);
		if (cohort) {
			cohort.replayable = replayable;
			return;
		}
		if (this.#seen.has(token)) {
			if (!replayable) {
				this.#seen.delete(token);
				this.#remember(token);
			}
			return;
		}
		const marker = this.#unrendered.live.get(token);
		if (!marker) return;
		marker.replayable = replayable;
		if (replayable) return;
		retire(this.#unrendered, token, marker.contribution);
		this.#unrendered.live.delete(token);
		this.#remember(token);
	}
	invalidatePolicy(generation: number, revision: number): void {
		if (generation === this.#generation && revision === this.#revision) return;
		this.#generation = generation;
		this.#revision = revision;
		const burst = this.#unrendered;
		burst.policyGeneration = generation;
		burst.policyRevision = revision;
		for (const letter of letters) {
			burst.retiredUnknownCount += burst.retiredByClass[letter].count;
			burst.retiredByClass[letter] = { count: 0, hasNonLowBase: false };
		}
		for (const marker of burst.live.values()) marker.contribution = neutral(marker.contribution);
	}
	render(epochs: OverflowEpochs): { text: string; receiptId: number } | undefined {
		if (this.#receipt || !this.hasPending) return undefined;
		const burst = this.#unrendered;
		const cohort = new Map<string, CohortMember>();
		for (const [token, marker] of burst.live)
			cohort.set(token, {
				...marker,
				frozenFingerprint: marker.fingerprint,
				contribution: { ...marker.contribution },
			});
		const text = line(burst);
		this.#receipt = { id: this.#nextReceipt++, epochs: { ...epochs }, burst, cohort, text };
		this.#unrendered = newBurst(this.#nextBurst++, this.#now(), this.#generation, this.#revision);
		return { text, receiptId: this.#receipt.id };
	}
	onReceipt(receiptId: number, accepted: boolean, epochs: OverflowEpochs): void {
		const receipt = this.#receipt;
		if (!receipt || receipt.id !== receiptId || !sameEpoch(receipt.epochs, epochs)) return;
		this.#receipt = undefined;
		if (accepted) {
			for (const [token, member] of receipt.cohort) {
				const changed = member.pendingChangedSelection;
				if (!changed || changed.fingerprint === member.frozenFingerprint) {
					if (member.replayable)
						this.#seen.set(token, {
							fingerprint: member.frozenFingerprint,
							observationRevision: member.observationRevision,
						});
					else this.#remember(token);
					continue;
				}
				this.#inactive.delete(token);
				this.count({ ...changed, replayable: member.replayable });
			}
			return;
		}
		const frozen = receipt.burst;
		const current = this.#unrendered;
		if (frozen.policyGeneration !== this.#generation || frozen.policyRevision !== this.#revision) {
			for (const letter of letters) {
				frozen.retiredUnknownCount += frozen.retiredByClass[letter].count;
				frozen.retiredByClass[letter] = { count: 0, hasNonLowBase: false };
			}
			for (const member of receipt.cohort.values()) member.contribution = neutral(member.contribution);
		}
		current.firstAt = Math.min(current.firstAt, frozen.firstAt);
		current.mixed ||= frozen.mixed;
		current.retiredUnknownCount += frozen.retiredUnknownCount;
		for (const letter of letters) {
			const from = frozen.retiredByClass[letter],
				into = current.retiredByClass[letter];
			into.count += from.count;
			into.hasNonLowBase ||= from.hasNonLowBase;
			if (from.representative && better(from.representative, into.representative))
				into.representative = from.representative;
		}
		for (const [token, member] of receipt.cohort) {
			const changed = member.pendingChangedSelection;
			const c =
				changed && changed.fingerprint !== member.frozenFingerprint
					? contribution(changed, member.contribution.firstSeq)
					: member.contribution;
			if (member.replayable) current.live.set(token, { ...member, contribution: c });
			else {
				retire(current, token, c);
				this.#remember(token);
			}
		}
	}
	clear(): void {
		this.#receipt = undefined;
		this.#inactive.clear();
		this.#seen.clear();
		this.#unrendered = newBurst(this.#nextBurst++, this.#now(), this.#generation, this.#revision);
	}
}
