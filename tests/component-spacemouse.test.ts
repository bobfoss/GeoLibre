import { act, render } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";

const { useSpaceMouse } = await import("../apps/geolibre-desktop/src/hooks/useSpaceMouse");
const { useDesktopSettingsStore } =
  await import("../apps/geolibre-desktop/src/hooks/useDesktopSettings");

let callback: ((event: { payload: unknown }) => void) | undefined;
let frames: Map<number, FrameRequestCallback>;
let unlistens: number;
let now: number;

beforeEach(() => {
  callback = undefined;
  frames = new Map();
  unlistens = 0;
  now = 100;
  let id = 0;
  mock.method(performance, "now", () => now);
  mock.method(document, "hasFocus", () => true);
  mock.method(globalThis, "requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  mock.method(globalThis, "cancelAnimationFrame", (key: number) => {
    frames.delete(key);
  });
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (fn: typeof callback) => {
        callback = fn;
        return 1;
      },
      invoke: async (cmd: string) => {
        if (cmd === "plugin:event|unlisten") unlistens++;
        return 1;
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
});

afterEach(async () => {
  await Promise.resolve();
  mock.restoreAll();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
});

function probe() {
  const views: unknown[] = [];
  const engine = {
    readView: () => ({ center: [0, 0], zoom: 5, pitch: 0, bearing: 0 }),
    getRenderSurface: () => null,
    applyView: (view: unknown) => {
      views.push(view);
    },
  } as unknown as MapEngine;
  const ref = { current: engine };
  function Probe({ generation = 1 }: { generation?: number }) {
    useSpaceMouse(ref, generation);
    return null;
  }
  return { ...render(createElement(Probe)), views, Probe };
}

function send(payload: unknown = { device: "usb", translation: [0, 0, -350], rotation: null }) {
  callback?.({ payload });
}

async function frame() {
  now += 16;
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => {
    pending.forEach((fn) => fn(now));
  });
}

test("native events move the camera, stop on blur/disconnect, and unlisten on unmount", async () => {
  const app = probe();
  await act(async () => {
    await Promise.resolve();
  });
  send();
  await frame();
  assert.equal(app.views.length, 1);
  window.dispatchEvent(new Event("blur"));
  assert.equal(frames.size, 0);
  await frame();
  assert.equal(app.views.length, 1);
  send();
  send(null);
  assert.equal(frames.size, 0);
  send();
  app.unmount();
  await Promise.resolve();
  assert.equal(frames.size, 0);
  assert.equal(unlistens, 1);
});

test("text input and visible dialogs suppress navigation", async () => {
  const app = probe();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  send();
  await frame();
  assert.equal(app.views.length, 0);
  input.remove();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  mock.method(dialog, "getClientRects", () => [{ width: 100, height: 100 }]);
  document.body.append(dialog);
  send();
  await frame();
  assert.equal(app.views.length, 0);
  dialog.remove();
  send();
  await frame();
  assert.equal(app.views.length, 1);
});

test("disabling the device and changing engines discard pending input", async () => {
  const app = probe();
  send();
  app.rerender(createElement(app.Probe, { generation: 2 }));
  await frame();
  assert.equal(app.views.length, 0);
  send();
  await act(() => {
    const state = useDesktopSettingsStore.getState();
    state.setDesktopSettings({
      ...state.desktopSettings,
      spaceMouse: { ...state.desktopSettings.spaceMouse, enabled: false },
    });
  });
  await frame();
  assert.equal(app.views.length, 0);
  assert.equal(frames.size, 0);
});
