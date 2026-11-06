import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Agent,
  FunctionTool,
  Message,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import {
  ChatGptModel,
  chatGptRequest,
} from "../apps/geolibre-desktop/src/lib/assistant/chatgpt-model";
import {
  chatGptReady,
  orderedSubscriptionEvents,
  useChatGptConnection,
  type ResponseEvent,
  type SubscriptionTransport,
} from "../apps/geolibre-desktop/src/lib/assistant/chatgpt-connection";
import { configForProvider } from "../apps/geolibre-desktop/src/lib/assistant/provider";
import { PROVIDER_FIELDS } from "../apps/geolibre-desktop/src/lib/assistant/provider-fields";

const prompt = Message.fromMessageData({
  role: "user",
  content: [{ text: "Style my layer" }],
});

test("IPC success waits for delayed channel completion before releasing tools", async () => {
  const model = new ChatGptModel({ modelId: "m" }, () =>
    orderedSubscriptionEvents(
      async (receive) => {
        receive({ type: "response.output_text.delta", delta: "Working" });
        // WebView2 can resolve invoke before delivering the queued terminal event.
        setTimeout(() => receive(complete([call])), 10);
      },
      () => {}
    )
  );
  const events = await collect(model.stream([prompt], { toolSpecs: [spec] }));
  assert.equal(
    events.filter(
      (e) =>
        e.type === "modelContentBlockStartEvent" &&
        e.start?.type === "toolUseStart"
    ).length,
    1
  );
});

test("IPC channel completion still waits for command success and propagates a late error", async () => {
  const model = new ChatGptModel({ modelId: "m" }, () =>
    orderedSubscriptionEvents(
      async (receive) => {
        receive(complete([call]));
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw { code: "service", message: "Late native failure" };
      },
      () => {}
    )
  );
  const seen: ModelStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of model.stream([prompt], { toolSpecs: [spec] }))
      seen.push(event);
  }, /Late native failure/);
  assert.ok(
    !seen.some((e) => e.type === "modelContentBlockStartEvent" && e.start)
  );
});

test("missing channel completion times out and Stop cancels the native request", async () => {
  const missing = orderedSubscriptionEvents(
    async () => {},
    () => {},
    undefined,
    10
  );
  await assert.rejects(async () => {
    for await (const event of missing) assert.fail(String(event));
  }, /could not be delivered/);
  const controller = new AbortController();
  let cancelled = 0;
  const stream = orderedSubscriptionEvents(
    async (receive) => {
      receive({ type: "geolibre.started" });
      controller.abort();
    },
    () => {
      cancelled++;
    },
    controller.signal
  );
  await assert.rejects(
    async () => {
      for await (const event of stream) assert.fail(String(event));
    },
    { name: "AbortError" }
  );
  assert.ok(cancelled > 0);
});
const spec = {
  name: "style_layer",
  description: "Style",
  inputSchema: { type: "object" as const, properties: {} },
};
const call = {
  type: "function_call",
  id: "fc_1",
  namespace: "geolibre",
  name: "style_layer",
  call_id: "call_1",
  arguments: "{}",
  status: "completed",
};
const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "opaque-provider-reasoning",
};
const message = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Done", annotations: [] }],
};
function complete(output: unknown[]): ResponseEvent {
  return {
    type: "response.completed",
    response: { status: "completed", output },
  };
}
function transport(events: ResponseEvent[]): SubscriptionTransport {
  return async function* () {
    yield* events;
  };
}
async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

test("subscription request uses stateless Responses and namespaced GeoLibre tools", () => {
  const body = chatGptRequest("chosen-model", [prompt], {
    systemPrompt: "Use the map",
    toolSpecs: [spec],
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "Use the map");
  assert.deepEqual(body.tools, [
    {
      type: "namespace",
      name: "geolibre",
      description: "GeoLibre map and data operations",
      tools: [
        {
          type: "function",
          name: "style_layer",
          description: "Style",
          parameters: spec.inputSchema,
          strict: false,
        },
      ],
    },
  ]);
  for (const key of [
    "temperature",
    "max_output_tokens",
    "previous_response_id",
    "conversation",
    "authorization",
  ])
    assert.equal(key in body, false);
});

test("tool calls are withheld on failed, incomplete and abruptly interrupted streams", async () => {
  for (const ending of [
    [],
    [{ type: "response.failed" }],
    [{ type: "response.incomplete" }],
    [{ type: "error" }],
  ]) {
    const seen: ModelStreamEvent[] = [];
    const model = new ChatGptModel(
      { modelId: "m" },
      transport([
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.output_text.delta", delta: "Working" },
        ...ending,
      ])
    );
    await assert.rejects(async () => {
      for await (const e of model.stream([prompt], { toolSpecs: [spec] }))
        seen.push(e);
    });
    assert.ok(seen.some((e) => e.type === "modelContentBlockDeltaEvent"));
    assert.ok(
      !seen.some((e) => e.type === "modelContentBlockStartEvent" && e.start)
    );
  }
});

test("a malformed later tool prevents the entire batch from being released", async () => {
  const model = new ChatGptModel(
    { modelId: "m" },
    transport([
      complete([call, { ...call, call_id: "call_2", arguments: "{" }]),
    ])
  );
  const seen: ModelStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const e of model.stream([prompt], { toolSpecs: [spec] }))
      seen.push(e);
  });
  assert.ok(
    !seen.some((e) => e.type === "modelContentBlockStartEvent" && e.start)
  );
});

test("unknown tools and namespaces cannot dispatch GeoLibre operations", async () => {
  for (const bad of [
    { ...call, namespace: "other" },
    { ...call, name: "unknown" },
    { ...call, arguments: "[]" },
  ]) {
    await assert.rejects(
      collect(
        new ChatGptModel({ modelId: "m" }, transport([complete([bad])])).stream(
          [prompt],
          {
            toolSpecs: [spec],
          }
        )
      )
    );
  }
});

test("cancellation after completion but before tool release prevents execution", async () => {
  const controller = new AbortController();
  const model = new ChatGptModel({ modelId: "m" }, async function* () {
    yield complete([call]);
    controller.abort();
  });
  await assert.rejects(
    collect(
      model.stream([prompt], {
        toolSpecs: [spec],
        cancelSignal: controller.signal,
      })
    ),
    { name: "AbortError" }
  );
});

test("real Strands loop retains exact provider history and executes tools once", async () => {
  let requests = 0;
  let operations = 0;
  const model = new ChatGptModel({ modelId: "m" }, async function* (body) {
    requests++;
    if (requests === 1) {
      assert.equal(operations, 0);
      yield { type: "response.output_item.done", output_index: 0, item: call };
      assert.equal(operations, 0);
      yield complete([
        reasoning,
        call,
        { ...call, id: "fc_2", call_id: "call_2" },
      ]);
    } else {
      const input = body.input as Record<string, unknown>[];
      assert.deepEqual(
        input.find((i) => i.type === "reasoning"),
        reasoning
      );
      assert.deepEqual(
        input.find((i) => i.call_id === "call_1" && i.type === "function_call"),
        call
      );
      assert.equal(
        input.filter((i) => i.type === "function_call_output").length,
        2
      );
      assert.equal(operations, 2);
      yield { type: "response.output_text.delta", delta: "Done" };
      yield complete([message]);
    }
  });
  const agent = new Agent({
    model,
    tools: [
      new FunctionTool({
        ...spec,
        callback: () => {
          operations++;
          return "styled";
        },
      }),
    ],
  });
  await agent.invoke("Style the layer");
  await agent.invoke("What did you do?");
  assert.equal(requests, 3);
  assert.equal(operations, 2);
});

test("newly loaded plugin tools enter the next request", async () => {
  let requests = 0;
  const model = new ChatGptModel({ modelId: "m" }, async function* (body) {
    const tools = (body.tools as { tools: { name: string }[] }[])[0].tools;
    assert.equal(
      tools.some((t) => t.name === "plugin_tool"),
      ++requests === 2
    );
    yield complete([message]);
  });
  await collect(model.stream([prompt], { toolSpecs: [spec] }));
  await collect(
    model.stream([prompt], {
      toolSpecs: [spec, { ...spec, name: "plugin_tool" }],
    })
  );
});

test("item-done events retain tools and reasoning when terminal output is empty", async () => {
  let requests = 0;
  let operations = 0;
  const model = new ChatGptModel({ modelId: "m" }, async function* (body) {
    if (++requests === 1) {
      // Preserve provider ordering, even if finished items arrive out of order.
      yield { type: "response.output_item.done", output_index: 1, item: call };
      yield {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoning,
      };
      assert.equal(operations, 0);
    } else {
      const input = body.input as Record<string, unknown>[];
      assert.deepEqual(
        input.filter((i) => i.type === "reasoning"),
        [reasoning]
      );
      assert.deepEqual(
        input.filter((i) => i.type === "function_call"),
        [call]
      );
      assert.equal(
        input.filter((i) => i.type === "function_call_output").length,
        1
      );
      yield {
        type: "response.output_item.done",
        output_index: 0,
        item: message,
      };
    }
    yield complete([]);
  });
  const agent = new Agent({
    model,
    tools: [
      new FunctionTool({
        ...spec,
        callback: () => {
          operations++;
          return "styled";
        },
      }),
    ],
  });
  for (const prompt of ["Style my layer", "What changed?"]) {
    for await (const event of agent.stream(prompt)) void event;
  }
  assert.equal(requests, 3);
  assert.equal(operations, 1);
});

test("empty or unfinished completed outputs fail without releasing tools", async () => {
  for (const events of [
    [complete([])],
    [
      { type: "response.output_item.done", output_index: 1, item: call },
      complete([]),
    ],
    [
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.output_item.added", output_index: 1, item: reasoning },
      complete([]),
    ],
  ]) {
    const seen: ModelStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of new ChatGptModel(
        { modelId: "m" },
        transport(events)
      ).stream([prompt], { toolSpecs: [spec] }))
        seen.push(event);
    }, /complete reply/);
    assert.ok(
      !seen.some((e) => e.type === "modelContentBlockStartEvent" && e.start)
    );
  }
});

test("subscription provider has no credential fields and cannot activate on the web", () => {
  useChatGptConnection.setState({
    supported: true,
    connected: true,
    permitted: true,
  });
  assert.equal(chatGptReady(), false);
  assert.equal(
    configForProvider("chatgpt", "m", { OPENAI_API_KEY: "must-not-fallback" }),
    null
  );
  assert.deepEqual(PROVIDER_FIELDS.chatgpt, []);
  useChatGptConnection.setState({
    supported: false,
    connected: false,
    permitted: false,
  });
});
