import { describe, expect, it } from "vitest";
import { createSession, EXPIRY_MARGIN_MS, type EndReason, type Schedule } from "../src/auth/session";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { loadAllRoutes } from "../src/service/loader";
import { createTraceStore } from "../src/ui/traceStore";

/**
 * When the session ends the page forgets the whole traces it holds
 * (docs/PLAN.md, section 4). These are the two pieces it relies on: the
 * session says when it ends, also when only the clock ran out, and the
 * store forgets what it holds and what is on its way.
 */
function manualTimers(): { schedule: Schedule; timers: { run: () => void; delayMs: number; cancelled: boolean }[] } {
  const timers: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (run, delayMs) => {
    const timer = { run, delayMs, cancelled: false };
    timers.push(timer);
    return () => void (timer.cancelled = true);
  };
  return { schedule, timers };
}

describe("the end of a session", () => {
  it("is told once to every listener, with its reason, and at once to one that comes late", () => {
    const session = createSession("synthetic-token", 10_000_000);
    const heard: EndReason[] = [];
    session.onEnd((reason) => heard.push(reason));
    session.onEnd((reason) => heard.push(reason));
    session.end("unauthorized");
    session.end("signed_out");
    expect(heard).toEqual(["unauthorized", "unauthorized"]);
    session.onEnd((reason) => heard.push(reason));
    expect(heard).toEqual(["unauthorized", "unauthorized", "unauthorized"]);
  });

  it("comes from the clock alone: the timer ends it when the token's time is up, with no request", () => {
    let now = 1_000_000;
    const session = createSession("synthetic-token", now + 3_600_000);
    const { schedule, timers } = manualTimers();
    const heard: EndReason[] = [];
    session.onEnd((reason) => heard.push(reason));
    session.watchExpiry(() => now, schedule);
    expect(timers.map((timer) => timer.delayMs)).toEqual([3_600_000 - EXPIRY_MARGIN_MS]);
    now += 3_600_000 - EXPIRY_MARGIN_MS;
    timers[0]?.run();
    expect(heard).toEqual(["expired"]);
    expect(session.authorization(now)).toBeNull();
  });

  it("is checked again when the timer fires early, and the timer goes when the session ends otherwise", () => {
    let now = 0;
    const session = createSession("synthetic-token", 3_600_000);
    const { schedule, timers } = manualTimers();
    const heard: EndReason[] = [];
    session.onEnd((reason) => heard.push(reason));
    session.watchExpiry(() => now, schedule);
    now = 1_000;
    timers[0]?.run();
    expect(heard).toEqual([]);
    expect(timers).toHaveLength(2);
    session.end("signed_out");
    expect(timers[1]?.cancelled).toBe(true);
    expect(heard).toEqual(["signed_out"]);
  });
});

describe("the store of whole traces", () => {
  const NOW = Date.parse("2026-11-09T20:00:00.000Z");
  const rider = generateRider({ seed: 8, nowMs: NOW });

  it("forgets what it holds and does not keep an answer that was on its way", async () => {
    const service = createDemoService(rider);
    const routes = (await loadAllRoutes(service, NOW)).routes;
    const [first, second] = routes;
    if (first === undefined || second === undefined) throw new Error("the demo rider has routes");
    const store = createTraceStore(service);
    let told = 0;
    store.onChange(() => (told += 1));
    await store.get(first);
    expect(store.known(first.ref)?.lines.length).toBeGreaterThan(0);
    const late = store.get(second);
    expect(store.has(second.ref)).toBe(true);
    store.forget();
    expect(told).toBe(2);
    expect(store.known(first.ref)).toBeUndefined();
    expect(store.has(second.ref)).toBe(false);
    await late;
    expect(store.known(second.ref)).toBeUndefined();
    // It can still be asked after forgetting.
    await store.get(first);
    expect(store.known(first.ref)).toBeDefined();
  });
});
