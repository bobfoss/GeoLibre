import { act, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";
import { geojsonLayer } from "./helpers/layer-fixtures";

const { useLayerRenderProgress } =
  await import("../apps/geolibre-desktop/src/hooks/useLayerRenderProgress");
const { LayerRenderProgressPanel } =
  await import("../apps/geolibre-desktop/src/components/layout/LayerRenderProgressPanel");

it("connects the actual panel to a GeoPackage layer on an already-running map", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  type Event = { sourceId?: string; coord?: { key: string } };
  const listeners = new Map<string, Set<(event: Event) => void>>();
  let loaded = false;
  const map = {
    getSource: (id: string) => (id === "gpkg-native-source" ? {} : undefined),
    isSourceLoaded: () => loaded,
    on: (type: string, listener: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    off: (type: string, listener: (event: Event) => void) => listeners.get(type)?.delete(listener),
  };
  const mapRef = {
    current: {
      capabilities: { nativeMapInstance: true },
      getMap: () => map,
    } as unknown as MapEngine,
  };
  useAppStore.setState({
    layers: [
      geojsonLayer({
        name: "ab_structures_en",
        metadata: { sourceIds: ["gpkg-native-source"], sourceKind: "maplibre-gl-vector" },
      }),
    ],
  });
  function Harness() {
    return createElement(LayerRenderProgressPanel, { progress: useLayerRenderProgress(mapRef, 1) });
  }
  const view = render(createElement(Harness));
  act(() => t.mock.timers.tick(300));
  assert.equal(
    screen.getByRole("progressbar", { name: "ab_structures_en" }).getAttribute("aria-valuetext"),
    "Preparing layer…",
  );
  act(() => {
    loaded = true;
    for (const listener of listeners.get("render") ?? []) listener({});
    t.mock.timers.tick(100);
  });
  assert.equal(
    screen.getByRole("progressbar", { name: "ab_structures_en" }).getAttribute("aria-valuenow"),
    "100",
  );
  view.unmount();
  assert.equal(
    [...listeners.values()].every((set) => set.size === 0),
    true,
  );
});
