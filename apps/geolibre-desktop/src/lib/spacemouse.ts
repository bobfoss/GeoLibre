import type { MapViewState } from "@geolibre/core";
import type { MapRenderSurface } from "@geolibre/map";

export interface SpaceMouseSettings {
  enabled: boolean;
  sensitivity: number;
  deadZone: number;
  invertZoom: boolean;
}

export const DEFAULT_SPACEMOUSE_SETTINGS: SpaceMouseSettings = {
  enabled: true,
  sensitivity: 1,
  deadZone: 0.05,
  invertZoom: false,
};

export function normalizeSpaceMouseSettings(value: unknown): SpaceMouseSettings {
  const candidate = (
    value && typeof value === "object" ? value : {}
  ) as Partial<SpaceMouseSettings>;
  const finite = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    sensitivity: finite(candidate.sensitivity, 1, 0.1, 4),
    deadZone: finite(candidate.deadZone, 0.05, 0, 0.3),
    invertZoom: candidate.invertZoom === true,
  };
}

type Vector = [number, number, number];
export interface SpaceMouseMotion {
  device: string;
  translation: Vector | null;
  rotation: Vector | null;
}

function isVector(value: unknown): value is Vector {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= -32768 && n <= 32767)
  );
}

/** Merge split HID packets without letting a stale half keep moving the map. */
export class SpaceMouseInput {
  private device = "";
  private translation: Vector = [0, 0, 0];
  private rotation: Vector = [0, 0, 0];
  private translationTime = -Infinity;
  private rotationTime = -Infinity;

  reset(): void {
    this.device = "";
    this.translation = [0, 0, 0];
    this.rotation = [0, 0, 0];
    this.translationTime = this.rotationTime = -Infinity;
  }

  accept(value: unknown, now: number): void {
    if (!value || typeof value !== "object") {
      this.reset();
      return;
    }
    const motion = value as Partial<SpaceMouseMotion>;
    if (
      typeof motion.device !== "string" ||
      (motion.translation != null && !isVector(motion.translation)) ||
      (motion.rotation != null && !isVector(motion.rotation))
    ) {
      this.reset();
      return;
    }
    if (motion.device !== this.device) this.reset();
    this.device = motion.device;
    if (isVector(motion.translation)) {
      this.translation = [...motion.translation];
      this.translationTime = now;
    }
    if (isVector(motion.rotation)) {
      this.rotation = [...motion.rotation];
      this.rotationTime = now;
    }
  }

  sample(now: number, deadZone: number): number[] {
    const axis = (raw: number) => {
      const value = Math.max(-1, Math.min(1, raw / 350));
      return Math.abs(value) <= deadZone
        ? 0
        : (Math.sign(value) * (Math.abs(value) - deadZone)) / (1 - deadZone);
    };
    return [
      ...(now - this.translationTime < 150 ? this.translation.map(axis) : [0, 0, 0]),
      ...(now - this.rotationTime < 150 ? this.rotation.map(axis) : [0, 0, 0]),
    ];
  }
}

/** Camera-relative pan via the renderer's projection, with a level horizon.
 * HID Y is forward/back, Z is up/down; rotation about Y (roll) is unused.
 * Units are per second, independent of HID report and display refresh rates.
 */
export function spaceMouseView(
  view: MapViewState,
  surface: Pick<MapRenderSurface, "project" | "unproject"> | null,
  axes: number[],
  seconds: number,
  settings: SpaceMouseSettings,
): MapViewState | null {
  if (!settings.enabled || ![0, 1, 2, 3, 5].some((i) => axes[i] !== 0)) return null;
  const dt = Math.max(0, Math.min(0.05, seconds)) * settings.sensitivity;
  if (!dt) return null;
  let center: [number, number] = [...view.center];
  if (surface && (axes[0] || axes[1])) {
    const origin = surface.project(view.center);
    const target = surface.unproject([
      origin.x + axes[0] * 600 * dt,
      origin.y + axes[1] * 600 * dt,
    ]);
    if (target && Number.isFinite(target.lng) && Number.isFinite(target.lat)) {
      center = [target.lng, Math.max(-90, Math.min(90, target.lat))];
    }
  }
  // Engines enforce the project's tighter zoom, pitch and geographic bounds.
  return {
    center,
    zoom: Math.max(0, Math.min(24, view.zoom + axes[2] * 2 * dt * (settings.invertZoom ? -1 : 1))),
    pitch: Math.max(0, Math.min(85, view.pitch + axes[3] * 60 * dt)),
    bearing: ((((view.bearing + axes[5] * 90 * dt + 180) % 360) + 360) % 360) - 180,
  };
}
