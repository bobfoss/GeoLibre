import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, FunctionTool, Message } from "@strands-agents/sdk";
import {
  readAssistantImage,
  imageContent,
  imageDataUrl,
  validateImageBatch,
  MAX_IMAGE_BYTES,
  MAX_CONVERSATION_IMAGE_BYTES,
} from "../apps/geolibre-desktop/src/lib/assistant/images";
import {
  ChatGptModel,
  chatGptInput,
} from "../apps/geolibre-desktop/src/lib/assistant/chatgpt-model";

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDa0AAAAASUVORK5CYII=",
    "base64",
  ),
);
const file = () => new File([png], "screenshot.png", { type: "image/png" });
const decoded = async () => {};

test("attachments validate bytes, size and decoding before creating local previews", async () => {
  const image = await readAssistantImage(file(), decoded);
  assert.equal(image.name, "screenshot.png");
  assert.equal(image.format, "png");
  assert.equal(image.byteLength, png.length);
  assert.equal(image.dataUrl, imageDataUrl("png", png));
  await assert.rejects(
    readAssistantImage(new File(["<svg/>"], "fake.png", { type: "image/png" }), decoded),
    /valid PNG/,
  );
  await assert.rejects(readAssistantImage(new File([], "empty.png"), decoded), /4 MB/);
  await assert.rejects(
    readAssistantImage(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "large.png"), decoded),
    /4 MB/,
  );
  await assert.rejects(
    readAssistantImage(file(), async () => {
      throw new Error("Corrupt image");
    }),
    /Corrupt/,
  );
  assert.throws(() => validateImageBatch(Array(5).fill(image)), /4 images/);
  assert.throws(
    () => validateImageBatch([{ ...image, byteLength: MAX_CONVERSATION_IMAGE_BYTES + 1 }]),
    /8 MB/,
  );
  assert.throws(
    () => imageContent([{ ...image, dataUrl: "https://example.test/photo.png" }]),
    /Invalid image/,
  );
});

test("multimodal input keeps text and local images in one user message", async () => {
  const image = await readAssistantImage(file(), decoded);
  const input = chatGptInput([
    Message.fromMessageData({
      role: "user",
      content: [{ text: "What is here?" }, ...imageContent([image, image])],
    }),
  ]);
  assert.deepEqual(input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "What is here?" },
        ...[image, image].map((i) => ({
          type: "input_image",
          image_url: i.dataUrl,
          detail: "auto",
        })),
      ],
    },
  ]);
  assert.throws(
    () =>
      chatGptInput([
        Message.fromMessageData({
          role: "user",
          content: [
            { image: { format: "png", source: { url: "https://example.test/image.png" } } },
          ],
        }),
      ]),
    /Remote image URLs/,
  );
  assert.throws(
    () =>
      chatGptInput([
        Message.fromMessageData({
          role: "user",
          content: Array(3).fill({
            image: { format: "png", source: { bytes: new Uint8Array(MAX_IMAGE_BYTES) } },
          }),
        }),
      ]),
    /8 MB image limit/,
  );
});

test("real Strands tool loop and follow-up preserve the original image exactly once", async () => {
  const image = await readAssistantImage(file(), decoded);
  let requests = 0;
  let operations = 0;
  const model = new ChatGptModel({ modelId: "chosen-model" }, async function* (body) {
    requests++;
    const content = (body.input as { content?: Record<string, unknown>[] }[]).flatMap(
      (item) => item.content ?? [],
    );
    assert.deepEqual(
      content.filter((part) => part.type === "input_image"),
      [{ type: "input_image", image_url: image.dataUrl, detail: "auto" }],
    );
    const output =
      requests === 1
        ? [
            {
              type: "function_call",
              namespace: "geolibre",
              name: "inspect_map",
              call_id: "call_1",
              arguments: "{}",
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done" }],
            },
          ];
    yield { type: "response.completed", response: { status: "completed", output } };
  });
  const agent = new Agent({
    model,
    tools: [
      new FunctionTool({
        name: "inspect_map",
        description: "Inspect map",
        inputSchema: { type: "object", properties: {} },
        callback: () => {
          operations++;
          return "map inspected";
        },
      }),
    ],
  });
  await agent.invoke([{ text: "Compare this image to the map" }, ...imageContent([image])]);
  await agent.invoke("What did the image show?");
  assert.equal(requests, 3);
  assert.equal(operations, 1);
});
