import type { GeoLibreLayer } from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import { generatorSourceId, invertedSourceId, labelSourceId, sourceId } from "./style-layer-ids";

export interface LayerRenderProgress {
  layerId: string;
  name: string;
  phase: "loading" | "tiles" | "rendering" | "complete" | "error";
  /** Tile requests in the current batch, not a percentage of database rows. */
  loaded: number;
  total: number;
}

interface SourceEvent {
  sourceId?: string;
  coord?: { key: string | number };
}

interface Work {
  layerId: string;
  sources: Set<string>;
  tiles: Map<string, boolean>;
  error: boolean;
  finishedAt?: number;
  startedAt: number;
}

/** Observe source processing and tile loading, then wait for a rendered frame.
 * No elapsed-time estimate is presented as measured rendering progress.
 */
export function trackLayerRendering(
  map: Pick<MapLibreMap, "on" | "off" | "getSource" | "isSourceLoaded">,
  getLayers: () => readonly GeoLibreLayer[],
  onProgress: (progress: LayerRenderProgress[]) => void,
  subscribeLayers?: (changed: (reset?: boolean) => void) => () => void,
) {
  const work = new Map<string, Work>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let previous = "[]";
  let owners = new Map<string, GeoLibreLayer[]>();
  let lastLayers: readonly GeoLibreLayer[] | undefined;

  const readOwners = () => {
    const layers = getLayers();
    if (layers !== lastLayers) {
      lastLayers = layers;
      owners = new Map();
      for (const layer of layers) {
        if (!layer.visible) continue;
        for (const id of [
          sourceId(layer.id),
          labelSourceId(layer.id),
          generatorSourceId(layer.id),
          invertedSourceId(layer.id),
          // GeoPackage / DuckDB imports keep their control's native sources.
          ...(Array.isArray(layer.metadata.sourceIds) ? layer.metadata.sourceIds : []),
          layer.metadata.sourceId,
          layer.source.sourceId,
        ]) {
          if (typeof id !== "string" || !id) continue;
          const existing = owners.get(id) ?? [];
          if (!existing.includes(layer)) owners.set(id, [...existing, layer]);
        }
      }
    }
    return owners;
  };

  const sourceLoaded = (id: string) => Boolean(map.getSource(id)) && map.isSourceLoaded(id);

  const publish = () => {
    timer = undefined;
    if (disposed) return;
    const now = Date.now();
    const layers = new Map(
      getLayers()
        .filter((layer) => layer.visible)
        .map((l) => [l.id, l]),
    );
    const rows: LayerRenderProgress[] = [];
    for (const [id, item] of work) {
      const layer = layers.get(id);
      if (
        !layer ||
        (item.finishedAt !== undefined && now - item.finishedAt >= (item.error ? 6000 : 1500))
      ) {
        work.delete(id);
        continue;
      }
      // Don't flash a panel for cached tiles that finish in a single frame.
      if (!item.error && now - item.startedAt < 200) continue;
      if (!item.error && item.finishedAt !== undefined && item.finishedAt - item.startedAt < 200)
        continue;
      const loaded = [...item.tiles.values()].filter(Boolean).length;
      const total = item.tiles.size;
      rows.push({
        layerId: id,
        name: layer.name,
        phase: item.error
          ? "error"
          : item.finishedAt !== undefined
            ? "complete"
            : total > loaded
              ? "tiles"
              : [...item.sources].every(sourceLoaded)
                ? "rendering"
                : "loading",
        loaded,
        total,
      });
    }
    const serialized = JSON.stringify(rows);
    if (serialized !== previous) {
      previous = serialized;
      onProgress(rows);
    }
    if (work.size) schedule();
  };

  // Batch tile-event bursts so progress does not re-render React for every tile.
  const schedule = () => {
    if (!disposed && timer === undefined) timer = setTimeout(publish, 100);
  };

  const findWork = (event: SourceEvent, start: boolean): Work[] => {
    const source = event.sourceId;
    if (!source) return [];
    const items: Work[] = [];
    for (const layer of readOwners().get(source) ?? []) {
      let item = work.get(layer.id);
      if (start && (!item || item.finishedAt !== undefined)) {
        item = {
          layerId: layer.id,
          sources: new Set(),
          tiles: new Map(),
          error: false,
          startedAt: Date.now(),
        };
        work.set(layer.id, item);
      }
      if (!item) continue;
      item.sources.add(source);
      items.push(item);
    }
    return items;
  };

  const tileKey = (event: SourceEvent) =>
    event.coord ? `${event.sourceId}:${event.coord.key}` : undefined;
  const loading = (event: SourceEvent) => {
    const key = tileKey(event);
    for (const item of findWork(event, true)) {
      if (key) item.tiles.set(key, false);
      schedule();
    }
  };
  const data = (event: SourceEvent) => {
    const key = tileKey(event);
    for (const item of findWork(event, false)) {
      if (item.finishedAt !== undefined) continue;
      if (key && item.tiles.has(key)) item.tiles.set(key, true);
      schedule();
    }
  };
  const abort = (event: SourceEvent) => {
    const key = tileKey(event);
    for (const item of findWork(event, false)) {
      if (key) item.tiles.delete(key);
      else if (event.sourceId) item.sources.delete(event.sourceId);
      if (!item.sources.size) work.delete(item.layerId);
      schedule();
    }
  };
  const error = (event: object) => {
    // MapLibre forwards the source's event-parent data on errors, although
    // its public ErrorEvent type does not declare sourceId.
    for (const item of findWork(event as SourceEvent, true)) {
      item.error = true;
      item.finishedAt = Date.now();
      schedule();
    }
  };
  const reconcile = (reset = false) => {
    if (reset) {
      work.clear();
      previous = "[]";
      onProgress([]);
      // The previous project's map sources still exist until the next sync.
      // Do not seed them into the new project's progress.
      return;
    }
    // Import controls may create a map source before publishing its store
    // layer. Seed already-loading sources when those layers arrive, as well
    // as when a tracker attaches to an existing map.
    for (const [id, layers] of readOwners()) {
      if (!map.getSource(id) || sourceLoaded(id)) continue;
      for (const layer of layers) {
        const item = work.get(layer.id);
        if (!item || !item.sources.has(id)) {
          findWork({ sourceId: id }, true);
          schedule();
          break;
        }
      }
    }
    if (work.size || previous !== "[]") schedule();
  };
  const render = () => {
    for (const [id, item] of work) {
      if (item.finishedAt !== undefined) continue;
      // Style replacement/removal must not strand a progress row.
      for (const source of item.sources) {
        if (!map.getSource(source)) item.sources.delete(source);
      }
      if (!item.sources.size) work.delete(id);
      else if ([...item.sources].every(sourceLoaded)) item.finishedAt = Date.now();
    }
    if (work.size || previous !== "[]") schedule();
  };

  map.on("sourcedataloading", loading);
  map.on("sourcedata", data);
  map.on("sourcedataabort", abort);
  map.on("error", error);
  map.on("render", render);
  const unsubscribeLayers = subscribeLayers?.(reconcile);
  reconcile();

  return () => {
    disposed = true;
    unsubscribeLayers?.();
    clearTimeout(timer);
    map.off("sourcedataloading", loading);
    map.off("sourcedata", data);
    map.off("sourcedataabort", abort);
    map.off("error", error);
    map.off("render", render);
    work.clear();
    onProgress([]);
  };
}
