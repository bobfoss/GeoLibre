import { render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import type { LayerRenderProgress } from "../packages/map/src/layer-render-progress";

const { LayerRenderProgressPanel } =
  await import("../apps/geolibre-desktop/src/components/layout/LayerRenderProgressPanel");

it("shows per-layer measured progress and leaves unknown totals indeterminate", () => {
  const progress: LayerRenderProgress[] = [
    { layerId: "a", name: "SQL parcels", phase: "tiles", loaded: 3, total: 4 },
    { layerId: "b", name: "Roads", phase: "loading", loaded: 0, total: 0 },
  ];
  const view = render(createElement(LayerRenderProgressPanel, { progress }));
  assert.equal(
    screen.getByRole("progressbar", { name: "SQL parcels" }).getAttribute("aria-valuenow"),
    "75",
  );
  assert.equal(
    screen.getByRole("progressbar", { name: "Roads" }).hasAttribute("aria-valuenow"),
    false,
  );
  assert.equal(screen.getByText("Loading tiles · 3 / 4").textContent, "Loading tiles · 3 / 4");
  view.rerender(createElement(LayerRenderProgressPanel, { progress: [] }));
  assert.equal(screen.queryAllByRole("progressbar").length, 0);
});

it("distinguishes rendered and failed layers without claiming 100% on failure", () => {
  render(
    createElement(LayerRenderProgressPanel, {
      progress: [
        { layerId: "a", name: "Parcels", phase: "complete", loaded: 4, total: 4 },
        { layerId: "b", name: "Roads", phase: "error", loaded: 0, total: 4 },
      ],
    }),
  );
  assert.equal(
    screen.getByRole("progressbar", { name: "Parcels" }).getAttribute("aria-valuenow"),
    "100",
  );
  assert.equal(
    screen.getByRole("progressbar", { name: "Roads" }).getAttribute("aria-valuetext"),
    "Could not render layer",
  );
  assert.equal(
    screen.getByRole("progressbar", { name: "Roads" }).hasAttribute("aria-valuenow"),
    false,
  );
});
