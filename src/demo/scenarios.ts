/**
 * Demo mode: synthetic riders served by the in-memory demo service, behind
 * the same `ToolCaller` door the real client will use. Besides two riding
 * profiles there are two scenarios that exist to show the empty and the
 * error states of the interface.
 */
import { ToolCallError, type RawRouteList, type ToolCaller } from "../service/contract";
import { createDemoService } from "./fakeService";
import { generateRider } from "./generator";

export type DemoScenario = "commuter" | "heavy" | "empty" | "error";

export const DEMO_SCENARIOS: readonly { readonly id: DemoScenario; readonly label: string }[] = [
  { id: "commuter", label: "Uso diario" },
  { id: "heavy", label: "Uso intensivo (muchas rutas)" },
  { id: "empty", label: "Cuenta sin rutas" },
  { id: "error", label: "Fallo del servicio" },
];

/** Fixed, so the demo shows the same rider on every visit. */
export const DEMO_SEED = 2026;

export function isDemoScenario(value: string): value is DemoScenario {
  return DEMO_SCENARIOS.some((scenario) => scenario.id === value);
}

/**
 * Reads the demo scenario from the address fragment: `#demo` or
 * `#demo=heavy`. Null when the fragment does not ask for the demo.
 */
export function scenarioFromHash(hash: string): DemoScenario | null {
  const match = /^#demo(?:=([a-z]+))?$/.exec(hash);
  if (match === null) return null;
  const name = match[1];
  if (name === undefined) return "commuter";
  return isDemoScenario(name) ? name : "commuter";
}

/**
 * A caller for one scenario. `delayMs` makes every answer wait a little, so
 * the loading states can be seen; tests pass 0.
 */
export function createDemoCaller(scenario: DemoScenario, nowMs: number, delayMs = 120): ToolCaller {
  const service = createDemoService(
    generateRider({ seed: DEMO_SEED, nowMs, profile: scenario === "heavy" ? "heavy" : "commuter" }),
  );
  let listCalls = 0;
  return {
    async callTool(name, args) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = await service.callTool(name, args);
      if (name !== "list_routes") return result;
      listCalls += 1;
      if (scenario === "empty") {
        const list = result as RawRouteList;
        return { ...list, routes: [], matched_routes: 0, returned_routes: 0, truncated: false };
      }
      if (scenario === "error" && listCalls >= 2) {
        throw new ToolCallError("upstream_unavailable", "simulated failure of the demo");
      }
      return result;
    },
  };
}
