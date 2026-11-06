import {
  Model,
  type Message,
  type StreamOptions,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { streamChatGpt, type SubscriptionTransport } from "./chatgpt-connection";
import { imageDataUrl, MAX_CONVERSATION_IMAGE_BYTES } from "./images";

type Item = Record<string, unknown>;
function object(value: unknown): Item {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ChatGPT response item.");
  return value as Item;
}

/** Replay provider reasoning alongside tool calls rather than losing it in SDK normalization. */
export function chatGptInput(messages: Message[]): Item[] {
  const input: Item[] = [];
  let imageBytes = 0;
  for (const message of messages) {
    if (message.content.some((block) => block.type === "imageBlock")) {
      if (message.role !== "user") throw new Error("Only user image attachments are supported.");
      const content = message.content.map((block) => {
        if (block.type === "textBlock") return { type: "input_text", text: block.text };
        if (block.type !== "imageBlock" || block.source.type !== "imageSourceBytes")
          throw new Error(
            "Attach local PNG, JPEG, or WebP images. Remote image URLs are not supported.",
          );
        imageBytes += block.source.bytes.length;
        if (imageBytes > MAX_CONVERSATION_IMAGE_BYTES)
          throw new Error(
            "This conversation has reached its 8 MB image limit. Clear the conversation before attaching more images.",
          );
        return {
          type: "input_image",
          image_url: imageDataUrl(block.format, block.source.bytes),
          detail: "auto",
        };
      });
      input.push({ role: "user", content });
      continue;
    }
    // Store the exact completed output in an opaque SDK reasoning block. This keeps
    // reasoning order, encrypted content, namespaces and provider item IDs intact.
    const saved = message.content.find((b) => b.type === "reasoningBlock" && b.redactedContent);
    if (message.role === "assistant" && saved?.type === "reasoningBlock" && saved.redactedContent) {
      const envelope = object(JSON.parse(new TextDecoder().decode(saved.redactedContent)));
      if (envelope.type === "geolibre_response" && Array.isArray(envelope.output)) {
        input.push(...envelope.output.map(object));
        continue;
      }
    }
    for (const block of message.content) {
      switch (block.type) {
        case "textBlock":
          input.push({
            role: message.role,
            content: [
              {
                type: message.role === "assistant" ? "output_text" : "input_text",
                text: block.text,
              },
            ],
          });
          break;
        case "reasoningBlock": {
          if (block.redactedContent) {
            const item = object(JSON.parse(new TextDecoder().decode(block.redactedContent)));
            if (item.type !== "reasoning") throw new Error("Invalid saved reasoning item.");
            input.push(item);
          }
          break;
        }
        case "toolUseBlock":
          input.push({
            type: "function_call",
            namespace: "geolibre",
            call_id: block.toolUseId,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case "toolResultBlock":
          input.push({
            type: "function_call_output",
            call_id: block.toolUseId,
            output: JSON.stringify(block.content),
          });
          break;
        default:
          throw new Error(
            "ChatGPT subscription supports text, image attachments, and GeoLibre tools.",
          );
      }
    }
  }
  return input;
}

export function chatGptRequest(
  modelId: string,
  messages: Message[],
  options?: StreamOptions,
): Item {
  const instructions =
    typeof options?.systemPrompt === "string"
      ? options.systemPrompt
      : options?.systemPrompt
          ?.filter((b) => b.type === "textBlock")
          .map((b) => b.text)
          .join("\n");
  const specs = options?.toolSpecs ?? [];
  const body: Item = {
    model: modelId,
    input: chatGptInput(messages),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (instructions) body.instructions = instructions;
  if (specs.length)
    body.tools = [
      {
        type: "namespace",
        name: "geolibre",
        description: "GeoLibre map and data operations",
        tools: specs.map((s) => ({
          type: "function",
          name: s.name,
          description: s.description ?? "",
          parameters: s.inputSchema ?? { type: "object", properties: {} },
          strict: false,
        })),
      },
    ];
  if (options?.toolChoice) {
    const choice = options.toolChoice;
    body.tool_choice =
      "auto" in choice
        ? "auto"
        : "any" in choice
        ? "required"
        : { type: "function", namespace: "geolibre", name: choice.tool.name };
  }
  return body;
}

/** Stateless Responses adapter: Strands owns history and runs tools through its existing registry. */
export class ChatGptModel extends Model<{ modelId: string }> {
  constructor(
    private config: { modelId: string },
    private transport: SubscriptionTransport = streamChatGpt,
  ) {
    super();
  }
  updateConfig(config: { modelId: string }): void {
    this.config = { ...this.config, ...config };
  }
  getConfig(): { modelId: string } {
    return { ...this.config };
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (!this.config.modelId) throw new Error("Choose a ChatGPT model in Settings → AI Providers.");
    yield { type: "modelMessageStartEvent", role: "assistant" };
    let textStarted = false;
    let completed: Item | undefined;
    const outputItems = new Map<number, Item>();
    const pendingItems = new Set<number>();
    for await (const event of this.transport(
      chatGptRequest(this.config.modelId, messages, options),
      options?.cancelSignal,
    )) {
      if (options?.cancelSignal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        const index = event.output_index;
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
          throw new Error("ChatGPT returned an invalid output item index.");
        if (event.type === "response.output_item.added") pendingItems.add(index);
        else {
          outputItems.set(index, object(event.item));
          pendingItems.delete(index);
        }
      }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        if (!textStarted) {
          yield { type: "modelContentBlockStartEvent" };
          textStarted = true;
        }
        yield {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: event.delta },
        };
      } else if (event.type === "response.completed") completed = object(event.response);
      else if (["response.failed", "response.incomplete", "error"].includes(event.type))
        throw new Error("ChatGPT did not complete the response. Try again.");
    }
    if (options?.cancelSignal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (!completed || completed.status !== "completed" || !Array.isArray(completed.output))
      throw new Error("ChatGPT disconnected before completing the response. Try again.");
    // Validate the entire batch before yielding ANY tool block. Strands can execute a block
    // immediately when it closes, so validating a later call after yielding is unsafe.
    // Subscription streams can leave response.completed.output empty. The item-done
    // events contain the full calls and reasoning; retain them, but release nothing
    // until the terminal event AND the native request have succeeded.
    completed.output.forEach((item, index) => {
      outputItems.set(index, object(item));
      pendingItems.delete(index);
    });
    const ordered = [...outputItems.entries()].sort(([a], [b]) => a - b);
    if (!ordered.length || pendingItems.size || ordered.some(([index], i) => index !== i))
      throw new Error("ChatGPT completed without a complete reply. Try again.");
    const items = ordered.map(([, item]) => item);
    if (
      items.some((item) => !["message", "reasoning", "function_call"].includes(String(item.type)))
    )
      throw new Error("ChatGPT returned an unsupported response item.");
    const tools = new Set(options?.toolSpecs?.map((s) => s.name));
    const calls = items.filter((item) => item.type === "function_call");
    const seen = new Set<string>();
    for (const call of calls) {
      if (
        call.namespace !== "geolibre" ||
        typeof call.name !== "string" ||
        !tools.has(call.name) ||
        typeof call.call_id !== "string" ||
        seen.has(call.call_id) ||
        typeof call.arguments !== "string"
      )
        throw new Error("ChatGPT returned an invalid GeoLibre tool call.");
      object(JSON.parse(call.arguments));
      seen.add(call.call_id);
    }
    if (textStarted) yield { type: "modelContentBlockStopEvent" };
    if (!textStarted) {
      const text = items
        .filter((item) => item.type === "message")
        .flatMap((item) => (Array.isArray(item.content) ? item.content.map(object) : []))
        .filter((part) => part.type === "output_text" || part.type === "refusal")
        .map((part) => String(part.text ?? part.refusal ?? ""))
        .join("");
      if (text) {
        yield { type: "modelContentBlockStartEvent" };
        yield {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text },
        };
        yield { type: "modelContentBlockStopEvent" };
      }
    }
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: {
        type: "reasoningContentDelta",
        redactedContent: new TextEncoder().encode(
          JSON.stringify({ type: "geolibre_response", output: items }),
        ),
      },
    };
    yield { type: "modelContentBlockStopEvent" };
    for (const item of items) {
      if (options?.cancelSignal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (item.type === "function_call") {
        yield {
          type: "modelContentBlockStartEvent",
          start: {
            type: "toolUseStart",
            name: item.name as string,
            toolUseId: item.call_id as string,
          },
        };
        yield {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "toolUseInputDelta", input: item.arguments as string },
        };
        yield { type: "modelContentBlockStopEvent" };
      }
    }
    yield {
      type: "modelMessageStopEvent",
      stopReason: calls.length ? "toolUse" : "endTurn",
    };
    const usage = completed.usage as
      | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
      | undefined;
    if (usage)
      yield {
        type: "modelMetadataEvent",
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        },
      };
  }
}
