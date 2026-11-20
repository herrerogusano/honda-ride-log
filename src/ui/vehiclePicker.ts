/**
 * The motorbike selector of the hero (docs/PLAN.md, section 19). It takes the
 * place of the line that names the motorbike («<model> · Ride Log») only
 * when the account has more than one, with the look of the compact year
 * menu and a 44 px tap target. Next to it, «N motos en tu cuenta», or the
 * «Dada de baja» mark when the chosen one is cancelled.
 *
 * The label is the model. Two motorbikes of one model get the last three
 * characters of their registration («Forza 125 · …BCD») here and nowhere
 * else: the card, the downloads and the counters never see it.
 */
import type { VehicleOption } from "../domain/model";
import { el, uniqueId } from "./dom";

/** The «Dada de baja» mark, next to the selector, in the status plate and in «Mantenimiento». */
export function cancelledBadge(): HTMLElement {
  return el("span", { class: "vehicle-badge" }, "Dada de baja");
}

/** What a motorbike is called on screen outside the selector: its model alone. */
export function vehicleName(model: string | null): string {
  return model ?? "Tu moto";
}

/** The selector's label of one motorbike. */
export function vehicleLabel(vehicle: VehicleOption): string {
  let label = vehicleName(vehicle.model);
  if (vehicle.twinSuffix !== null) label += ` · …${vehicle.twinSuffix}`;
  if (vehicle.cancelled) label += " · dada de baja";
  return label;
}

/**
 * The selector, its options in `ordered` order (active first, cancelled
 * last), `chosen` selected. `onPick` is called once per change, with the
 * motorbike picked.
 */
export function vehiclePicker(
  ordered: readonly VehicleOption[],
  chosen: VehicleOption,
  onPick: (vehicle: VehicleOption) => void,
): HTMLElement {
  const id = uniqueId("vehicle");
  const select = el(
    "select",
    { id, class: "period-select vehicle-select" },
    ...ordered.map((vehicle, index) => el("option", { attrs: { value: String(index), selected: vehicle === chosen } }, vehicleLabel(vehicle))),
  );
  select.addEventListener("change", () => {
    const picked = ordered[Number(select.value)];
    if (picked !== undefined && picked !== chosen) onPick(picked);
  });
  return el(
    "div",
    { class: "vehicle-pick hero-eyebrow" },
    el(
      "div",
      { class: "period-compact" },
      el("label", { class: "sr-only", attrs: { for: id } }, "Moto"),
      select,
      // The arrow is drawn, not typed into the options.
      el("span", { class: "period-caret", attrs: { "aria-hidden": "true" } }),
    ),
    chosen.cancelled ? cancelledBadge() : el("span", { class: "vehicle-count" }, `${ordered.length} motos en tu cuenta`),
  );
}
