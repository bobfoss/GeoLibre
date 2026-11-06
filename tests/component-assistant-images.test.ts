import { act, render, screen, fireEvent } from "./helpers/dom";
import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import { test } from "node:test";
import { createElement } from "react";
import type { AssistantImage } from "../apps/geolibre-desktop/src/lib/assistant/images";

const { useAssistantImages } = await import(
  "../apps/geolibre-desktop/src/hooks/useAssistantImages"
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDa0AAAAASUVORK5CYII=",
  "base64",
);
const file = () => new NodeFile([png], "screenshot.png", { type: "image/png" }) as unknown as File;

test("draft previews can be removed and are cleared by account/profile changes", async (t) => {
  const previous = globalThis.createImageBitmap;
  let closed = 0;
  globalThis.createImageBitmap = async () =>
    ({
      width: 1,
      height: 1,
      close: () => {
        closed++;
      },
    } as ImageBitmap);
  t.after(() => {
    globalThis.createImageBitmap = previous;
  });
  let draft!: ReturnType<typeof useAssistantImages>;
  function Harness({ scope }: { scope: string }) {
    draft = useAssistantImages(scope);
    return null;
  }
  const view = render(createElement(Harness, { scope: "account-one" }));
  await act(() => draft.addFiles([file()]));
  assert.equal(draft.images.length, 1);
  assert.equal(closed, 1);
  act(() => draft.remove(draft.images[0].id));
  assert.equal(draft.images.length, 0);
  await act(() => draft.addFiles([file()]));
  view.rerender(createElement(Harness, { scope: "account-two" }));
  assert.equal(draft.images.length, 0);
  assert.equal(draft.loading, false);
});

test("an image read completing after Clear or sign-out cannot restore the attachment", async (t) => {
  const previous = globalThis.createImageBitmap;
  let finish!: (image: ImageBitmap) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  globalThis.createImageBitmap = () =>
    new Promise((resolve) => {
      finish = resolve;
      began();
    });
  t.after(() => {
    globalThis.createImageBitmap = previous;
  });
  let draft!: ReturnType<typeof useAssistantImages>;
  function Harness() {
    draft = useAssistantImages("account");
    return null;
  }
  render(createElement(Harness));
  let pending!: Promise<void>;
  await act(async () => {
    pending = draft.addFiles([file()]);
    await started;
  });
  assert.equal(draft.loading, true);
  await act(() => draft.addFiles([file()]));
  assert.match(draft.error, /still preparing/);
  act(() => draft.clear());
  await act(async () => {
    finish({ width: 1, height: 1, close() {} } as ImageBitmap);
    await pending;
  });
  assert.equal(draft.images.length, 0);
  assert.equal(draft.loading, false);
  assert.equal(draft.error, "");
});

test("the ChatGPT composer previews file and paste attachments, sends image-only prompts, and clears on sign-out", async (t) => {
  const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
  const { useDesktopSettingsStore } = await import(
    "../apps/geolibre-desktop/src/hooks/useDesktopSettings"
  );
  const { useChatGptConnection } = await import(
    "../apps/geolibre-desktop/src/lib/assistant/chatgpt-connection"
  );
  const { AssistantSession } = await import("../apps/geolibre-desktop/src/lib/assistant/agent");
  const { AssistantPanel } = await import(
    "../apps/geolibre-desktop/src/components/panels/AssistantPanel"
  );
  const previousAgent = navigator.userAgent;
  const previousDecode = globalThis.createImageBitmap;
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Windows" });
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} } as ImageBitmap);
  const connected = { supported: true, connected: true, permitted: true, email: null, revision: 1 };
  mockIPC(
    (command) => {
      if (command === "chatgpt_status") return connected;
      if (command === "chatgpt_models") return [{ id: "vision-model", name: "Vision model" }];
    },
    { shouldMockEvents: true },
  );
  t.after(() => {
    clearMocks();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: previousAgent });
    globalThis.createImageBitmap = previousDecode;
    useChatGptConnection.setState({ connected: false, permitted: false, supported: false });
  });
  useChatGptConnection.setState(connected);
  useDesktopSettingsStore.setState((state) => ({
    desktopSettings: {
      ...state.desktopSettings,
      aiProfiles: [
        {
          id: "vision",
          name: "ChatGPT",
          provider: "chatgpt",
          modelId: "vision-model",
          fieldValues: {},
        },
      ],
      defaultAiProfileId: "vision",
    },
  }));
  let received = 0;
  t.mock.method(
    AssistantSession.prototype,
    "stream",
    async function* (prompt: string, images: readonly AssistantImage[]) {
      assert.equal(prompt, "Describe the attached images.");
      assert.equal(images.length, 1);
      received++;
      yield { type: "text", text: "I can see the image." };
    },
  );
  const view = render(createElement(AssistantPanel, { mapControllerRef: { current: null } }));
  const picker = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  assert.ok(picker);
  await act(async () => {
    fireEvent.change(picker, { target: { files: [file()] } });
  });
  assert.equal(screen.getAllByRole("img", { name: "screenshot.png" }).length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Remove screenshot.png" }));
  assert.equal(screen.queryAllByRole("img", { name: "screenshot.png" }).length, 0);
  await act(async () => {
    fireEvent.change(picker, { target: { files: [file()] } });
  });
  const originalSettings = useDesktopSettingsStore.getState().desktopSettings;
  act(() =>
    useDesktopSettingsStore.setState({
      desktopSettings: {
        ...originalSettings,
        aiProfiles: originalSettings.aiProfiles.map((profile) => ({
          ...profile,
          provider: "openai" as const,
        })),
      },
    }),
  );
  assert.equal(
    screen.queryAllByRole("img", { name: "screenshot.png" }).length,
    0,
    "provider changes clear pending images even when profile/model IDs match",
  );
  act(() => useDesktopSettingsStore.setState({ desktopSettings: originalSettings }));
  await act(async () => {
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [file()] } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
  assert.equal(received, 1);
  assert.ok(screen.getByText("I can see the image."));
  assert.equal(screen.queryByRole("list", { name: "Attached images" }), null);
  assert.equal(
    screen.getAllByRole("img", { name: "screenshot.png" }).length,
    1,
    "sent preview stays in transcript",
  );
  act(() => useChatGptConnection.setState({ connected: false, permitted: false, revision: 2 }));
  assert.equal(screen.queryAllByRole("img", { name: "screenshot.png" }).length, 0);
  assert.equal(screen.queryByRole("button", { name: "Attach images" }), null);
  view.unmount();
});
