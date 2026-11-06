import { useEffect, type RefObject } from "react";
import type { MapEngine } from "@geolibre/map";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/is-tauri";
import { SpaceMouseInput, spaceMouseView } from "../lib/spacemouse";
import { useDesktopSettingsStore } from "./useDesktopSettings";

function canNavigate(): boolean {
  if (document.hidden || !document.hasFocus()) return false;
  if (
    document.activeElement?.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
    )
  )
    return false;
  return !Array.from(
    document.querySelectorAll("[role='dialog'], [role='alertdialog'], dialog[open]"),
  ).some((element) => element.getClientRects().length > 0);
}

/** Native reports drive the primary map only while the desktop has focus. */
export function useSpaceMouse(mapRef: RefObject<MapEngine | null>, generation: number): void {
  const settings = useDesktopSettingsStore((state) => state.desktopSettings.spaceMouse);
  useEffect(() => {
    if (!isTauri() || !settings.enabled) return;
    const input = new SpaceMouseInput();
    let disposed = false;
    let frame = 0;
    let previous = 0;
    let applying = false;
    let unlisten: (() => void) | undefined;
    const stop = () => {
      input.reset();
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
    };
    const tick = (now: number) => {
      frame = 0;
      if (disposed || !canNavigate()) {
        stop();
        return;
      }
      const engine = mapRef.current;
      const axes = input.sample(now, settings.deadZone);
      if (!engine || ![0, 1, 2, 3, 5].some((i) => axes[i] !== 0)) {
        previous = 0;
        return;
      }
      const seconds = previous ? (now - previous) / 1000 : 1 / 60;
      if (!applying) {
        previous = now;
        try {
          const next = spaceMouseView(
            engine.readView(),
            engine.getRenderSurface(),
            axes,
            seconds,
            settings,
          );
          if (next) {
            applying = true;
            void Promise.resolve(engine.applyView(next))
              .catch((error: unknown) => {
                stop();
                console.warn("SpaceMouse navigation failed", error);
              })
              .finally(() => {
                applying = false;
              });
          }
        } catch (error) {
          applying = false;
          stop();
          console.warn("SpaceMouse navigation failed", error);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    void getCurrentWindow()
      .listen<unknown>("geolibre:spacemouse", ({ payload }) => {
        if (disposed) return;
        if (payload === null || !canNavigate()) {
          stop();
          return;
        }
        input.accept(payload, performance.now());
        if (!frame) frame = requestAnimationFrame(tick);
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((error: unknown) => console.warn("SpaceMouse listener unavailable", error));
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => {
      disposed = true;
      stop();
      unlisten?.();
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
    };
  }, [mapRef, generation, settings]);
}
