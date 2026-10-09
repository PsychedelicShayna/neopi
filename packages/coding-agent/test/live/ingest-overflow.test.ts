import { describe, expect, it } from "bun:test";
import { LiveIngestOverflow, type OverflowClass, type OverflowObservation } from "../../src/live/ingest-overflow";

const epochs = { call: 1, source: 1, alert: 1 };
function known(
	token: string,
	slug = "model-e",
	letter: OverflowClass = "E",
	revision = 1,
	replayable = true,
): OverflowObservation {
	return { token, fingerprint: slug, observationRevision: revision, category: "known", slug, letter, replayable };
}
function unknown(token: string, revision = 1, replayable = true): OverflowObservation {
	return { token, fingerprint: "unknown", observationRevision: revision, category: "unknown", replayable };
}

describe("bounded overflow contributions", () => {
	it("keeps 321 active counted identities after repeated observations and A→B→A", () => {
		const overflow = new LiveIngestOverflow(() => 10);
		for (let n = 0; n < 321; n++) overflow.count(known(String(n)));
		for (let n = 0; n < 321; n++) {
			const token = String(n);
			for (let revision = 2; revision < 9; revision++)
				overflow.observe(known(token, revision % 2 ? "model-e" : "model-l", revision % 2 ? "E" : "L", revision));
			overflow.count(known(token, "model-e", "E", 9));
		}
		expect(overflow.stats.count).toBe(321);
		expect(overflow.stats.liveMarkers).toBe(321);
		expect(overflow.stats.knownCount).toBe(321);
		expect(overflow.stats.retiredByClass.E.count).toBe(0);
	});

	it("pins exactly 512 active token identities through repeated A→B→A selections", () => {
		const overflow = new LiveIngestOverflow();
		for (let n = 0; n < 512; n++) overflow.count(known(`active-${n}`, "model-a", "E"));
		for (let round = 0; round < 5; round++) {
			for (let n = 0; n < 512; n++) {
				const token = `active-${n}`;
				overflow.observe(known(token, "model-b", "X", 2 + round * 2));
				overflow.observe(known(token, "model-a", "E", 3 + round * 2));
				overflow.count(known(token, "model-a", "E", 3 + round * 2));
			}
			expect(overflow.stats.liveMarkers).toBe(512);
			expect(overflow.stats.count).toBe(512);
			expect(overflow.stats.knownCount).toBe(512);
			expect(overflow.stats.retiredByClass.X.count).toBe(0);
		}
	});

	it("subtracts the stored category rather than guessing from current pair", () => {
		for (const firstUnknown of [true, false]) {
			const overflow = new LiveIngestOverflow();
			overflow.count(firstUnknown ? unknown("A") : known("A"));
			overflow.count(firstUnknown ? known("B") : unknown("B"));
			overflow.setReplayable("B", false);
			overflow.count(known("C", "model-x", "X"));
			expect([overflow.stats.knownCount, overflow.stats.unknownCount]).toEqual([2, 1]);
			overflow.observe(known("A", "model-l", "L", 2));
			expect([overflow.stats.knownCount, overflow.stats.unknownCount]).toEqual(firstUnknown ? [3, 0] : [2, 1]);
			expect(overflow.stats.retiredByClass.E.count).toBe(firstUnknown ? 1 : 0);
			expect(overflow.stats.representative?.slug).toBe("model-x");
		}
	});

	it("retains an actual retired representative and dramatic non-low-base X", () => {
		const overflow = new LiveIngestOverflow();
		overflow.count(known("retired", "actual-e", "E"));
		overflow.setReplayable("retired", false);
		overflow.count(known("x", "luna-x", "X"));
		overflow.count(known("other-x", "astra-x", "X"));
		expect(overflow.stats.hasNonLowBaseX).toBe(true);
		overflow.observe(known("x", "low-l", "L", 2));
		overflow.observe(known("other-x", "low-l", "L", 2));
		expect(overflow.stats.representative?.slug).toBe("actual-e");
		expect(overflow.render(epochs)?.text).toContain("including class E actual-e");
	});

	it("freezes immutable E/X/unknown receipt and merges false under policy replacement", () => {
		const overflow = new LiveIngestOverflow();
		overflow.count(known("E", "actual-e", "E"));
		overflow.setReplayable("E", false);
		overflow.count(known("X", "actual-x", "X"));
		overflow.count(unknown("U"));
		const receipt = overflow.render(epochs)!;
		expect(receipt.text).toContain("actual-x");
		overflow.count(known("N", "new-e", "E"));
		overflow.invalidatePolicy(1, 1);
		expect(overflow.stats.count).toBe(1);
		overflow.onReceipt(receipt.receiptId, false, epochs);
		expect(overflow.stats.count).toBe(4);
		expect(overflow.stats.knownCount).toBe(0);
		expect(overflow.stats.retiredUnknownCount).toBe(1);
		expect(overflow.stats.retiredByClass.X.count).toBe(0);
		expect(overflow.render(epochs)?.text).toContain("4 deployments' catalog status and authorization not checked");
	});

	it("settles true without recounting unchanged tokens and admits changed frozen pairs once", () => {
		const overflow = new LiveIngestOverflow();
		overflow.count(known("same"));
		overflow.count(known("changed"));
		const receipt = overflow.render(epochs)!;
		overflow.observe(known("changed", "replacement", "L", 2));
		overflow.count(known("new", "new-e"));
		overflow.onReceipt(receipt.receiptId, true, epochs);
		expect(overflow.stats.count).toBe(2);
		overflow.count(known("same", "model-e", "E", 3));
		expect(overflow.stats.count).toBe(2);
		overflow.observe(known("same", "new-selection", "M", 4));
		expect(overflow.stats.count).toBe(3);
		overflow.onReceipt(receipt.receiptId, false, epochs);
		expect(overflow.stats.count).toBe(3);
	});

	it("retains all 712 frozen captures alongside 712 new tokens and retires evicted running tokens on false", () => {
		const overflow = new LiveIngestOverflow();
		for (let n = 0; n < 712; n++) overflow.count(known(`old-${n}`, `old-${n}`, n % 2 ? "E" : "X"));
		const receipt = overflow.render(epochs)!;
		for (let n = 0; n < 712; n++) {
			overflow.setReplayable(`old-${n}`, false); // ledger/captures released, run still running
			overflow.count(known(`new-${n}`, `new-${n}`, "L"));
		}
		expect(overflow.stats.receiptCohort).toBe(712);
		expect(overflow.stats.contributors).toBe(1424);
		overflow.onReceipt(receipt.receiptId, false, epochs);
		expect(overflow.stats.count).toBe(1424);
		expect(overflow.stats.liveMarkers).toBe(712);
		expect(overflow.stats.receiptCohort).toBe(0);
		expect(overflow.stats.retiredByClass.E.count).toBe(356);
		expect(overflow.stats.retiredByClass.X.count).toBe(356);
	});

	it("on true receipt changes an uncaptured still-running frozen token into retired class rather than marker 713", () => {
		const overflow = new LiveIngestOverflow();
		for (let n = 0; n < 712; n++) overflow.count(known(`old-${n}`));
		const receipt = overflow.render(epochs)!;
		for (let n = 0; n < 712; n++) {
			overflow.setReplayable(`old-${n}`, false);
			overflow.count(known(`new-${n}`, "new-l", "L"));
		}
		overflow.observe(known("old-0", "changed-e", "E", 2, false));
		overflow.onReceipt(receipt.receiptId, true, epochs);
		expect(overflow.stats.count).toBe(713);
		expect(overflow.stats.liveMarkers).toBe(712);
		expect(overflow.stats.retiredByClass.E.representative?.slug).toBe("changed-e");
		expect(overflow.stats.receiptCohort).toBe(0);
	});

	it("rejects old receipts after clear and wrong epoch", () => {
		const overflow = new LiveIngestOverflow();
		overflow.count(known("old"));
		const receipt = overflow.render(epochs)!;
		overflow.onReceipt(receipt.receiptId, false, { ...epochs, call: 2 });
		expect(overflow.stats.frozenCount).toBe(1);
		overflow.clear();
		overflow.count(unknown("new"));
		overflow.onReceipt(receipt.receiptId, false, epochs);
		expect(overflow.stats.count).toBe(1);
		expect(overflow.stats.unknownCount).toBe(1);
	});
});
