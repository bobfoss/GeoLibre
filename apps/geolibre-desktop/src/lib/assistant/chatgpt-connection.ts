import { create } from "zustand";
import { isTauri } from "../is-tauri";
import type { Channel } from "@tauri-apps/api/core";

export interface ChatGptStatus {
  supported: boolean;
  connected: boolean;
  permitted: boolean;
  email: string | null;
  revision: number;
}
export interface ChatGptModelChoice {
  id: string;
  name: string;
}
export const useChatGptConnection = create<ChatGptStatus & { error: string | null }>(() => ({
  supported: false,
  connected: false,
  permitted: false,
  email: null,
  revision: 0,
  error: null,
}));

export function supportsChatGpt(): boolean {
  return isTauri() && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}
export function chatGptReady(): boolean {
  const state = useChatGptConnection.getState();
  return supportsChatGpt() && state.connected && state.permitted;
}
export function connectionError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return Object.assign(new Error(error.message), error);
  }
  return new Error("Could not complete the ChatGPT connection. Try again.");
}
interface Commands {
  chatgpt_status: { args: undefined; result: ChatGptStatus };
  chatgpt_sign_in: { args: { newAccount: boolean }; result: void };
  chatgpt_sign_out: { args: undefined; result: { revoked: boolean } };
  chatgpt_models: { args: undefined; result: ChatGptModelChoice[] };
  chatgpt_cancel: { args: { requestId: string }; result: void };
  chatgpt_stream: {
    args: { requestId: string; body: Record<string, unknown>; onEvent: Channel<ResponseEvent> };
    result: void;
  };
}
export async function chatGptCommand<K extends keyof Commands>(
  command: K,
  ...parameters: Commands[K]["args"] extends undefined ? [] : [Commands[K]["args"]]
): Promise<Commands[K]["result"]> {
  if (!supportsChatGpt()) throw new Error("ChatGPT subscription requires the Windows desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<Commands[K]["result"]>(command, parameters[0]);
  } catch (error) {
    throw connectionError(error);
  }
}
export async function refreshChatGptStatus(): Promise<void> {
  if (!supportsChatGpt()) return;
  try {
    const status = await chatGptCommand("chatgpt_status");
    useChatGptConnection.setState({ ...status, error: null });
  } catch (error) {
    useChatGptConnection.setState({
      connected: false,
      permitted: false,
      error: connectionError(error).message,
    });
  }
}
let startup: Promise<void> | undefined;
/** One native listener per webview; only public connection metadata enters the store. */
export function initializeChatGptConnection(): Promise<void> {
  if (!supportsChatGpt()) return Promise.resolve();
  startup ??= (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("chatgpt-connection-changed", () => void refreshChatGptStatus());
    await refreshChatGptStatus();
  })().catch((error) => {
    startup = undefined;
    useChatGptConnection.setState({ error: connectionError(error).message });
  });
  return startup;
}

let modelRequest: Promise<ChatGptModelChoice[]> | undefined;
/** Settings and the assistant may show their pickers simultaneously. Share the request. */
export function discoverChatGptModels(): Promise<ChatGptModelChoice[]> {
  modelRequest ??= chatGptCommand("chatgpt_models").finally(() => {
    modelRequest = undefined;
  });
  return modelRequest;
}

export type ResponseEvent = Record<string, unknown> & { type: string };
export type SubscriptionTransport = (
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => AsyncIterable<ResponseEvent>;

/** Bridge native SSE events into the model's async iterator, including terminal IPC failures. */
export const streamChatGpt: SubscriptionTransport = async function* (body, signal) {
  const { Channel } = await import("@tauri-apps/api/core");
  const id = crypto.randomUUID();
  yield* orderedSubscriptionEvents(
    (receive) =>
      chatGptCommand("chatgpt_stream", {
        requestId: id,
        body,
        onEvent: new Channel<ResponseEvent>(receive),
      }),
    () => {
      void chatGptCommand("chatgpt_cancel", { requestId: id }).catch(() => {});
    },
    signal,
  );
};

/** The command result and channel messages travel separately through WebView2.
 * A successful invoke is not a fence: wait for both it and the terminal event.
 */
export async function* orderedSubscriptionEvents(
  start: (receive: (event: ResponseEvent) => void) => Promise<void>,
  cancel: () => void,
  signal?: AbortSignal,
  completionTimeoutMs = 5000,
): AsyncIterable<ResponseEvent> {
  const queue: ResponseEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let closed = false;
  let terminal = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed: Error | undefined;
  const abort = () => {
    cancel();
    wake?.();
  };
  const receive = (event: ResponseEvent) => {
    // The native acknowledgement closes the cancel-before-registration race.
    if (signal?.aborted) {
      abort();
      return;
    }
    if (closed) return;
    if (
      ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)
    ) {
      terminal = true;
      clearTimeout(timer);
    }
    if (event.type !== "geolibre.started") queue.push(event);
    wake?.();
  };
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  signal?.addEventListener("abort", abort, { once: true });
  const request = Promise.resolve()
    .then(() => start(receive))
    .then(() => {
      if (!terminal && !closed)
        timer = setTimeout(() => {
          failed = new Error(
            "The ChatGPT completion could not be delivered to the assistant. Try again.",
          );
          wake?.();
        }, completionTimeoutMs);
    })
    .catch((error) => {
      failed = connectionError(error);
    })
    .finally(() => {
      done = true;
      wake?.();
    });
  try {
    while (!done || (!terminal && !failed) || queue.length) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const event = queue.shift();
      if (event) yield event;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (failed) throw failed;
  } finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (!done) abort();
    void request;
  }
}
