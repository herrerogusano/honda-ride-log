import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { ToolCallError, type ToolArguments, type ToolCaller } from "../src/service/contract";
import { loadAllRoutes, LoadError, MAX_RETRIES_PER_LOAD, RETRY_DELAY_MS } from "../src/service/loader";
import { ServiceError } from "../src/service/mcpClient";

/**
 * One repeated request for a period that failed because MAPIT or the
 * service did not answer (docs/PLAN.md, "Carga de datos"). Against the demo
 * service with injected failures: it proves what the loader asks, not how
 * the real service or MAPIT behave.
 */
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const rider = generateRider({ seed: 7, nowMs: NOW });
/** The semester that failed in production on 2026-11-18. */
const JAN_JUN_2024 = "2024-01-01T00:00:00.000Z";

interface Harness {
  readonly caller: ToolCaller;
  readonly calls: ToolArguments["list_routes"][];
}

/** Fails the listed periods' requests with `error`, as many times as given. */
function failing(failures: Map<string, number>, error: () => Error): Harness {
  const demo = createDemoService(rider);
  const calls: ToolArguments["list_routes"][] = [];
  return {
    calls,
    caller: {
      async callTool(name, args) {
        if (name === "list_routes") {
          const period = args as ToolArguments["list_routes"];
          calls.push(period);
          const left = failures.get(period.from_time) ?? 0;
          if (left > 0) {
            failures.set(period.from_time, left - 1);
            throw error();
          }
        }
        return demo.callTool(name, args);
      },
    },
  };
}

const callsFor = (harness: Harness, from: string) => harness.calls.filter((one) => one.from_time === from);

async function loadError(promise: Promise<unknown>): Promise<LoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error("expected a LoadError");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a period that fails because MAPIT or the service did not answer", () => {
  it.each(["mapit_unavailable", "internal_error"])("after %s, is asked once more, after about a second, and the load completes", async (code) => {
    const clean = await loadAllRoutes(createDemoService(rider), NOW);
    const harness = failing(new Map([[JAN_JUN_2024, 1]]), () => new ToolCallError(code, "x"));
    const waits: number[] = [];
    const load = await loadAllRoutes(harness.caller, NOW, undefined, undefined, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([RETRY_DELAY_MS]);
    expect(RETRY_DELAY_MS).toBe(1_000);
    expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(2);
    expect(callsFor(harness, JAN_JUN_2024)[1]).toEqual(callsFor(harness, JAN_JUN_2024)[0]);
    expect(load.routes).toEqual(clean.routes);
    expect(load.requests).toBe(clean.requests + 1);
  });

  it("without an injected wait, really waits about a second before asking again (fake clock)", async () => {
    vi.useFakeTimers();
    const harness = failing(new Map([[JAN_JUN_2024, 1]]), () => new ToolCallError("mapit_unavailable", "x"));
    const load = loadAllRoutes(harness.caller, NOW);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(2);
    await vi.runAllTimersAsync();
    await expect(load).resolves.toMatchObject({ requests: expect.any(Number) });
  });

  it("fails the load as before when the repeated request fails too: once, no partial history", async () => {
    const harness = failing(new Map([[JAN_JUN_2024, 2]]), () => new ToolCallError("mapit_unavailable", "x"));
    const error = await loadError(loadAllRoutes(harness.caller, NOW, undefined, undefined, { sleep: async () => undefined }));
    expect({ step: error.step, kind: error.kind, detail: error.detail }).toEqual({ step: "routes", kind: "tool_error", detail: "mapit_unavailable" });
    expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(2);
  });

  it.each(["session_expired", "session_limit_reached", "rate_limited", "service_paused", "service_unavailable", "tool_error", "period_too_large"])(
    "after %s, is never asked again",
    async (code) => {
      const harness = failing(new Map([[JAN_JUN_2024, 1]]), () => new ToolCallError(code, "x"));
      const waits: number[] = [];
      const error = await loadError(loadAllRoutes(harness.caller, NOW, undefined, undefined, { sleep: async (ms) => void waits.push(ms) }));
      expect(error.detail).toBe(code);
      expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(1);
      expect(waits).toEqual([]);
    },
  );

  it("after a failure of this web's own transport (a timeout, a status), is never asked again", async () => {
    for (const make of [() => new ServiceError("timeout"), () => new ServiceError("http_status", "502"), () => new Error("boom")]) {
      const harness = failing(new Map([[JAN_JUN_2024, 1]]), make);
      await loadError(loadAllRoutes(harness.caller, NOW, undefined, undefined, { sleep: async () => undefined }));
      expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(1);
    }
  });

  it(`repeats at most ${MAX_RETRIES_PER_LOAD} requests in one load, whatever the number of failing periods`, async () => {
    const failures = new Map([
      ["2026-07-01T00:00:00.000Z", 1],
      ["2026-01-01T00:00:00.000Z", 1],
      ["2025-07-01T00:00:00.000Z", 1],
    ]);
    const harness = failing(failures, () => new ToolCallError("mapit_unavailable", "x"));
    const error = await loadError(loadAllRoutes(harness.caller, NOW, undefined, undefined, { sleep: async () => undefined }));
    expect(error.detail).toBe("mapit_unavailable");
    expect(MAX_RETRIES_PER_LOAD).toBe(2);
    expect(callsFor(harness, "2026-07-01T00:00:00.000Z")).toHaveLength(2);
    expect(callsFor(harness, "2026-01-01T00:00:00.000Z")).toHaveLength(2);
    expect(callsFor(harness, "2025-07-01T00:00:00.000Z")).toHaveLength(1);
  });

  it("asks nothing more when the load is no longer wanted after the wait", async () => {
    const harness = failing(new Map([[JAN_JUN_2024, 1]]), () => new ToolCallError("mapit_unavailable", "x"));
    let wanted = true;
    const error = await loadError(
      loadAllRoutes(harness.caller, NOW, undefined, () => wanted, {
        sleep: async () => {
          wanted = false;
        },
      }),
    );
    expect(error.kind).toBe("cancelled");
    expect(callsFor(harness, JAN_JUN_2024)).toHaveLength(1);
  });
});
