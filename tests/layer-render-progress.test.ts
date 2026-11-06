import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import {
  trackLayerRendering,
  type LayerRenderProgress,
} from "../packages/map/src/layer-render-progress";
import { geojsonLayer } from "./helpers/layer-fixtures";

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  type Event = { sourceId?: string; coord?: { key: string }; sourceDataType?: string };
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const sources = new Map<string, boolean>();
  const map = {
    on(type: string, listener: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    off(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
    getSource(id: string) {
      return sources.has(id) ? {} : undefined;
    },
    isSourceLoaded(id: string) {
      return sources.get(id) ?? false;
    },
  };
  let layers = [geojsonLayer(), geojsonLayer({ id: "layer-b", name: "Parcels" })];
  let rows: LayerRenderProgress[] = [];
  let changed: ((reset?: boolean) => void) | undefined;
  const dispose = trackLayerRendering(
    map as unknown as Parameters<typeof trackLayerRendering>[0],
    () => layers,
    (value) => {
      rows = value;
    },
    (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  );
  t.after(dispose);
  const emit = (type: string, sourceId?: string, key?: string) => {
    for (const fn of listeners.get(type) ?? [])
      fn({ sourceId, ...(key ? { coord: { key } } : {}) });
  };
  const start = (id = "layer-a") => {
    sources.set(`source-${id}`, false);
    emit("sourcedataloading", `source-${id}`);
  };
  return {
    sources,
    listeners,
    dispose,
    emit,
    start,
    rows: () => rows,
    setLayers: (value: typeof layers) => {
      layers = value;
      changed?.();
    },
    resetProject: () => changed?.(true),
    tick: (ms = 200) => t.mock.timers.tick(ms),
  };
}

it("tracks each layer independently and finishes only after its rendered frame", (t) => {
  const h = setup(t);
  h.start();
  h.start("layer-b");
  h.tick();
  assert.deepEqual(
    h.rows().map((r) => r.phase),
    ["loading", "loading"],
  );
  h.emit("sourcedataloading", "source-layer-a", "one");
  h.emit("sourcedataloading", "source-layer-a", "two");
  h.emit("sourcedata", "source-layer-a", "one");
  h.emit("sourcedata", "source-layer-a", "one");
  h.tick();
  assert.equal(h.rows()[0].loaded, 1);
  assert.equal(h.rows()[0].total, 2);
  assert.equal(h.rows()[0].phase, "tiles");
  h.emit("sourcedata", "source-layer-a", "two");
  h.sources.set("source-layer-a", true);
  h.tick();
  assert.equal(h.rows()[0].phase, "rendering");
  h.emit("render");
  h.tick();
  assert.equal(h.rows()[0].phase, "complete");
  assert.equal(h.rows()[1].phase, "loading");
  h.tick(1500);
  assert.deepEqual(
    h.rows().map((r) => r.layerId),
    ["layer-b"],
  );
});

it("tracks GeoPackage sources created before the layer enters the store", (t) => {
  const h = setup(t);
  h.sources.set("vector-gpkg-parcels", false);
  h.emit("sourcedataloading", "vector-gpkg-parcels");
  h.setLayers([
    geojsonLayer({
      metadata: { sourceKind: "maplibre-gl-vector", sourceIds: ["vector-gpkg-parcels"] },
    }),
  ]);
  h.tick();
  assert.equal(h.rows()[0].phase, "loading");
  h.emit("sourcedataloading", "vector-gpkg-parcels", "one");
  h.emit("sourcedataloading", "vector-gpkg-parcels", "two");
  h.emit("sourcedata", "vector-gpkg-parcels", "one");
  h.tick();
  assert.equal(h.rows()[0].loaded, 1);
  assert.equal(h.rows()[0].total, 2);
  h.sources.set("vector-gpkg-parcels", true);
  h.emit("render");
  h.tick();
  assert.equal(h.rows()[0].phase, "complete");
});

it("tracks every layer sharing a native source and waits for all of a layer's sources", (t) => {
  const h = setup(t);
  h.sources.set("shared", false);
  h.sources.set("additional", false);
  h.setLayers([
    geojsonLayer({ metadata: { sourceIds: ["shared", "additional"] } }),
    geojsonLayer({ id: "layer-b", metadata: { sourceId: "shared" } }),
  ]);
  h.tick();
  assert.equal(h.rows().length, 2);
  h.sources.set("shared", true);
  h.emit("render");
  h.tick();
  assert.equal(h.rows()[0].phase, "loading");
  assert.equal(h.rows()[1].phase, "complete");
});

it("clears progress when a project changes without seeding its old map sources", (t) => {
  const h = setup(t);
  h.start();
  h.tick();
  assert.equal(h.rows().length, 1);
  h.resetProject();
  h.tick();
  assert.deepEqual(h.rows(), []);
});

it("ignores basemap and hidden layers, and removes deleted layers", (t) => {
  const h = setup(t);
  h.setLayers([geojsonLayer({ visible: false })]);
  h.start();
  h.emit("sourcedataloading", "basemap");
  h.tick();
  assert.deepEqual(h.rows(), []);
  h.setLayers([geojsonLayer()]);
  h.start();
  h.tick();
  assert.equal(h.rows().length, 1);
  h.setLayers([]);
  h.tick();
  assert.deepEqual(h.rows(), []);
});

it("waits for derived label sources belonging to the same layer", (t) => {
  const h = setup(t);
  h.start();
  h.sources.set("source-layer-a-label", false);
  h.emit("sourcedataloading", "source-layer-a-label");
  h.sources.set("source-layer-a", true);
  h.tick();
  h.emit("render");
  h.tick();
  assert.equal(h.rows()[0].phase, "loading");
  h.sources.set("source-layer-a-label", true);
  h.emit("render");
  h.tick();
  assert.equal(h.rows()[0].phase, "complete");
});

it("settles aborted tiles, reports failure, and starts fresh on retry", (t) => {
  const h = setup(t);
  h.start();
  h.emit("sourcedataloading", "source-layer-a", "cancelled");
  h.emit("sourcedataabort", "source-layer-a", "cancelled");
  h.tick();
  assert.equal(h.rows()[0].total, 0);
  h.emit("error", "source-layer-a");
  h.sources.set("source-layer-a", true);
  h.emit("render");
  h.tick();
  assert.equal(h.rows()[0].phase, "error");
  h.start();
  h.tick();
  assert.equal(h.rows()[0].phase, "loading");
});

it("clears removed sources and unregisters listeners and timers on disposal", (t) => {
  const h = setup(t);
  h.start();
  h.tick();
  h.sources.clear();
  h.emit("render");
  h.tick();
  assert.deepEqual(h.rows(), []);
  h.start();
  h.tick();
  h.dispose();
  h.tick(10000);
  assert.deepEqual(h.rows(), []);
  assert.equal(
    [...h.listeners.values()].every((set) => set.size === 0),
    true,
  );
});

it("suppresses fast cached loads and resets the tile count for a new batch", (t) => {
  const h = setup(t);
  h.start();
  h.sources.set("source-layer-a", true);
  h.emit("render");
  h.tick();
  assert.deepEqual(h.rows(), []);
  h.start();
  h.emit("sourcedataloading", "source-layer-a", "new");
  h.tick();
  assert.equal(h.rows()[0].total, 1);
  assert.equal(h.rows()[0].loaded, 0);
});
