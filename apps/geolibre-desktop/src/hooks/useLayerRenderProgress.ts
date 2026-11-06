import { useEffect, useState, type RefObject } from "react";
import { applyGroupEffects, useAppStore } from "@geolibre/core";
import { trackLayerRendering, type LayerRenderProgress, type MapEngine } from "@geolibre/map";

/** Attach to the current map even when it was created before this UI mounted. */
export function useLayerRenderProgress(mapRef: RefObject<MapEngine | null>, generation: number) {
  const [progress, setProgress] = useState<LayerRenderProgress[]>([]);
  const renderer = useAppStore((state) => state.primaryRenderer);
  useEffect(() => {
    const engine = mapRef.current;
    const map = engine?.capabilities.nativeMapInstance ? engine.getMap() : null;
    if (!map) return;
    let previous = useAppStore.getState();
    let layers = applyGroupEffects(previous.layers, previous.layerGroups);
    return trackLayerRendering(
      map,
      () => {
        const state = useAppStore.getState();
        if (state.layers !== previous.layers || state.layerGroups !== previous.layerGroups) {
          layers = applyGroupEffects(state.layers, state.layerGroups);
          previous = state;
        }
        return layers;
      },
      setProgress,
      (changed) =>
        useAppStore.subscribe((state, before) => {
          if (state.projectGeneration !== before.projectGeneration) changed(true);
          else if (state.layers !== before.layers || state.layerGroups !== before.layerGroups)
            changed();
        }),
    );
  }, [mapRef, generation, renderer]);
  return progress;
}
