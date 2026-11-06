import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SPACEMOUSE_SETTINGS as defaults,
  normalizeSpaceMouseSettings,
  SpaceMouseInput,
  spaceMouseView,
} from "../apps/geolibre-desktop/src/lib/spacemouse";

const view = { center: [0, 0] as [number, number], zoom: 5, bearing: 0, pitch: 30 };
const surface = {
  project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: -lat * 10 }),
  unproject: ([x, y]: [number, number]) => ({ lng: x / 10, lat: -y / 10 }),
};

test("SpaceMouse settings migrate old files and reject invalid values", () => {
  assert.deepEqual(normalizeSpaceMouseSettings(undefined), defaults);
  assert.deepEqual(normalizeSpaceMouseSettings({ sensitivity: NaN, deadZone: Infinity }), defaults);
  assert.deepEqual(
    normalizeSpaceMouseSettings({
      enabled: false,
      sensitivity: 20,
      deadZone: -1,
      invertZoom: true,
    }),
    { enabled: false, sensitivity: 4, deadZone: 0, invertZoom: true },
  );
  assert.deepEqual(
    normalizeSpaceMouseSettings({ enabled: "false", sensitivity: "2", invertZoom: "true" }),
    defaults,
  );
});

test("split motion reports merge, expire independently, and stop immediately on release", () => {
  const input = new SpaceMouseInput();
  input.accept({ device: "usb", translation: [350, 0, -350] }, 0);
  input.accept({ device: "usb", rotation: [350, 0, 350] }, 100);
  assert.deepEqual(input.sample(101, 0), [1, 0, -1, 1, 0, 1]);
  assert.deepEqual(input.sample(150, 0), [0, 0, 0, 1, 0, 1]);
  input.accept({ device: "usb", rotation: [0, 0, 0] }, 151);
  assert.deepEqual(input.sample(151, 0), [0, 0, 0, 0, 0, 0]);
  input.accept({ device: "usb", translation: [350, 350, 350], rotation: [350, 350, 350] }, 200);
  assert.deepEqual(input.sample(350, 0), [0, 0, 0, 0, 0, 0]);
});

test("dead zone removes drift, preserves signs and caps maximum deflection", () => {
  const input = new SpaceMouseInput();
  input.accept({ device: "a", translation: [17, -17, 175], rotation: [-350, 1000, -1000] }, 0);
  assert.deepEqual(input.sample(1, 0.05).slice(0, 2), [0, 0]);
  assert.ok(Math.abs(input.sample(1, 0.05)[2] - 0.45 / 0.95) < 1e-10);
  assert.deepEqual(input.sample(1, 0.05).slice(3), [-1, 1, -1]);
});

test("switching devices, invalid packets, disconnect and focus reset cannot retain motion", () => {
  const input = new SpaceMouseInput();
  const motion = { device: "a", translation: [350, 0, 0] };
  input.accept(motion, 0);
  input.accept({ device: "b", rotation: [0, 0, 350] }, 1);
  assert.deepEqual(input.sample(2, 0), [0, 0, 0, 0, 0, 1]);
  for (const bad of [
    null,
    {},
    { device: "a", translation: [NaN, 0, 0] },
    { device: "a", rotation: [1, 2] },
  ]) {
    input.accept(motion, 0);
    input.accept(bad, 1);
    assert.deepEqual(input.sample(2, 0), [0, 0, 0, 0, 0, 0]);
  }
  input.accept(motion, 0);
  input.reset();
  assert.deepEqual(input.sample(1, 0), [0, 0, 0, 0, 0, 0]);
});

test("pan uses renderer projection and all navigation axes work together", () => {
  assert.deepEqual(spaceMouseView(view, surface, [1, -1, -1, 1, 0, 1], 0.05, defaults), {
    center: [3, 3],
    zoom: 4.9,
    pitch: 33,
    bearing: 4.5,
  });
  assert.equal(
    spaceMouseView(view, surface, [0, 0, -1, 0, 0, 0], 0.05, { ...defaults, invertZoom: true })
      ?.zoom,
    5.1,
  );
  assert.equal(spaceMouseView(view, surface, [0, 0, 0, 0, 1, 0], 0.05, defaults), null);
  assert.equal(
    spaceMouseView(view, surface, [1, 0, 0, 0, 0, 0], 0.05, { ...defaults, enabled: false }),
    null,
  );
});

test("motion is frame-rate independent and long frames cannot cause a jump", () => {
  const axes = [1, 0, -1, 1, 0, 1];
  const advance = (fps: number) => {
    let current = view;
    for (let i = 0; i < fps; i++)
      current = spaceMouseView(current, surface, axes, 1 / fps, defaults)!;
    return current;
  };
  const a = advance(30),
    b = advance(120);
  for (const key of ["zoom", "pitch", "bearing"] as const)
    assert.ok(Math.abs(a[key] - b[key]) < 1e-8);
  assert.ok(Math.abs(a.center[0] - b.center[0]) < 1e-8);
  assert.deepEqual(
    spaceMouseView(view, surface, axes, 10, defaults),
    spaceMouseView(view, surface, axes, 0.05, defaults),
  );
});

test("invalid map intersections preserve center; camera limits remain finite", () => {
  const outside = { ...surface, unproject: () => null };
  const result = spaceMouseView(
    { ...view, zoom: 24, pitch: 85, bearing: 179 },
    outside,
    [1, 1, 1, 1, 0, 1],
    0.05,
    defaults,
  )!;
  assert.deepEqual(result.center, view.center);
  assert.equal(result.zoom, 24);
  assert.equal(result.pitch, 85);
  assert.equal(result.bearing, -176.5);
  assert.deepEqual(
    spaceMouseView(view, null, [1, 0, 0, 0, 0, 0], 0.01, defaults)?.center,
    view.center,
  );
});
