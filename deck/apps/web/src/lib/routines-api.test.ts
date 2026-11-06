import { afterEach, expect, test } from "bun:test";
import type { GraphRunRecord, RoutineGraph, ValidationResult } from "@npi-deck/protocol";
import { RoutineRequestError, routinesApi } from "./routines-api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const graph: RoutineGraph = { version: 2, nodes: [{ id: "source", type: "event.source", config: { eventType: "manual" } }], edges: [] };
function respond(body: unknown, status = 200, observe?: (url: string, init?: RequestInit) => void): void {
 globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  observe?.(String(url), init);
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
 }) as typeof fetch;
}

test("graph validation retains structured expected 400 results", async () => {
 const result: ValidationResult = { valid: false, errors: [{ path: "/edges/1/to", keyword: "multiple", message: "input accepts one connection", params: {} }] };
 respond(result, 400, (url, init) => {
  expect(url).toBe("/api/routine-graphs/validate");
  expect(JSON.parse(String(init?.body))).toEqual(graph);
 });
 expect(await routinesApi.validateGraph(graph)).toEqual(result);
});

test("unexpected validator errors remain failed requests", async () => {
 respond({ error: "unavailable" }, 503);
 await expect(routinesApi.validateGraph(graph)).rejects.toBeInstanceOf(RoutineRequestError);
});

test("native save sends only native authoring fields and retains rejection paths", async () => {
 respond({ error: "invalid graph", details: [{ path: "/nodes/0/config", keyword: "required", message: "missing eventType", params: {} }] }, 400, (url, init) => {
  expect(url).toBe("/api/routines/routine%2Fid");
  expect(init?.method).toBe("PATCH");
  expect(JSON.parse(String(init?.body))).toEqual({ name: "Native", graph });
 });
 try { await routinesApi.update("routine/id", { name: "Native", graph }); throw new Error("unexpected success"); }
 catch (error) {
  expect(error).toBeInstanceOf(RoutineRequestError);
  expect((error as RoutineRequestError).status).toBe(400);
  expect((error as RoutineRequestError).errors[0]?.path).toBe("/nodes/0/config");
 }
});

test("preview uses transient endpoint with an explicit selected source", async () => {
 const activation = { eventType: "manual", sourceNodeId: "source", event: { id: "sample", truthy: "not true", empty: null } };
 const trace = { id: "preview", dryRun: true } as GraphRunRecord;
 respond(trace, 200, (url, init) => {
  expect(url).toBe("/api/routines/routine%2Fid/preview");
  expect(JSON.parse(String(init?.body))).toEqual(activation);
 });
 expect(await routinesApi.previewGraph("routine/id", activation)).toEqual(trace);
});

test("historical run and trace fetch directly by both escaped identifiers", async () => {
 const requests: string[] = [];
 respond({}, 200, url => requests.push(url));
 await routinesApi.run("routine/id", "old/run");
 await routinesApi.graphRun("routine/id", "old/run");
 expect(requests).toEqual(["/api/routines/routine%2Fid/runs/old%2Frun", "/api/routines/routine%2Fid/runs/old%2Frun/graph"]);
});

test("routine source creation sends specToml verbatim without a YAML field", async () => {
 const specToml = 'name = "Source"\nsteps = []\n\n[[trigger]]\n[trigger.manual]\n';
 const request = { name: "Source", enabled: false, specToml };
 respond({ id: "created", ...request }, 201, (url, init) => {
  expect(url).toBe("/api/routines");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual(request);
 });
 expect((await routinesApi.create(request)).specToml).toBe(specToml);
});

test("routine source updates send specToml and preserve returned source", async () => {
 const specToml = '# Authored source\nname = "Updated"\nsteps = []\n\n[[trigger]]\n[trigger.manual]\n';
 respond({ id: "routine/id", specToml }, 200, (url, init) => {
  expect(url).toBe("/api/routines/routine%2Fid");
  expect(init?.method).toBe("PATCH");
  expect(JSON.parse(String(init?.body))).toEqual({ specToml });
 });
 expect((await routinesApi.update("routine/id", { specToml })).specToml).toBe(specToml);
});
