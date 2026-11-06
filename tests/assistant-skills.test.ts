import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Message, type InvokableTool, type JSONValue, type ToolContext } from "@strands-agents/sdk";
import {
  ConversationSkills,
  skillCatalog,
  skillMetadata,
  supportsSkills,
  useAssistantSkills,
  type InstalledSkill,
  type skillCommand,
} from "../apps/geolibre-desktop/src/lib/assistant/skills";
import { chatGptInput } from "../apps/geolibre-desktop/src/lib/assistant/chatgpt-model";
import type { AssistantToolDeps } from "../apps/geolibre-desktop/src/lib/assistant/tools";

const manifest =
  "---\nname: sample-skill\ndescription: >\n  Inspect an image and\n  produce evidence.\ncompatibility: Python 3.12\nallowed-tools: Bash\n---\nRead references/check.md and run scripts/check.py.";
const skill: InstalledSkill = {
  id: "abc123",
  source: "https://github.com/example/skills/tree/commit",
  digest: "123456",
  enabled: true,
  manifest,
  files: ["SKILL.md", "references/check.md", "scripts/check.py"],
};
const deps: AssistantToolDeps = { getMapController: () => null };
function setup(t: TestContext) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: {} },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Windows" },
  });
  useAssistantSkills.setState({ skills: [skill], loaded: true, revision: 1 });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    useAssistantSkills.setState({ skills: [], loaded: false, revision: 0 });
  });
}
function executable(session: ConversationSkills, options = deps) {
  return session.tools(options).find((tool) => tool.name === "run_skill_script") as InvokableTool<
    unknown,
    JSONValue
  >;
}
test("skill metadata supports standard YAML and bounded compatibility recovery", () => {
  assert.equal(skillMetadata(manifest).description, "Inspect an image and produce evidence.\n");
  const wrapped = skillMetadata(
    "---\nname: wrapped\ndescription: First line.\nContinuation without indentation.\n---\nBody",
  );
  assert.match(wrapped.description, /Continuation/);
  assert.equal(wrapped.warnings.length, 1);
  for (const bad of [
    "no header",
    "---\nname: Wrong Name\ndescription: bad\n---",
    "---\nname: test\nname: duplicate\ndescription: bad\n---",
  ])
    assert.throws(() => skillMetadata(bad));
});
test("catalog advertises only enabled valid skills and keeps instructions on demand", () => {
  const catalog = skillCatalog([
    skill,
    { ...skill, id: "disabled", enabled: false },
    { ...skill, id: "invalid", manifest: "invalid" },
  ]);
  assert.match(catalog, /sample-skill/);
  assert.doesNotMatch(catalog, /disabled|references\/check.md|"invalid"/);
  assert.match(catalog, /never permission to run code/);
});
test("skills are absent from unsupported platforms", () => {
  assert.equal(supportsSkills(), false);
  assert.deepEqual(new ConversationSkills().tools(deps), []);
});
test("script execution requires approval, even without a confirmation callback", async (t) => {
  setup(t);
  let calls = 0;
  const session = new ConversationSkills((async () => {
    calls++;
    return { success: true };
  }) as typeof skillCommand);
  const input = {
    id: skill.id,
    script: "scripts/check.py",
    args: ["image.png"],
    reason: "Check the image locally",
  };
  await assert.rejects(executable(session).invoke(input), /declined/);
  await assert.rejects(
    executable(session, { ...deps, confirmCodeExecution: async () => false }).invoke(input),
    /declined/,
  );
  assert.equal(calls, 0);
  let review = "";
  await executable(session, {
    ...deps,
    confirmCodeExecution: async ({ code, tool }) => {
      assert.equal(tool, "run_skill_script");
      review = code;
      return true;
    },
  }).invoke(input);
  assert.equal(calls, 1);
  assert.match(review, /image.png/);
  assert.match(review, /123456/);
  assert.match(review, /file and network access/);
});
test("Stop during approval cannot launch a late script", async (t) => {
  setup(t);
  let calls = 0;
  let approve!: (value: boolean) => void;
  const session = new ConversationSkills((async () => {
    calls++;
    return { success: true };
  }) as typeof skillCommand);
  const pending = executable(session, {
    ...deps,
    confirmCodeExecution: () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  }).invoke({ id: skill.id, script: "scripts/check.py", args: [], reason: "Check" });
  session.cancel();
  approve(true);
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls, 0);
});
test("disabled and unknown scripts cannot execute; native failures are tool errors", async (t) => {
  setup(t);
  const session = new ConversationSkills((async () => ({
    success: false,
    exitCode: 2,
    text: "Missing dependency",
  })) as typeof skillCommand);
  const runner = executable(session, { ...deps, confirmCodeExecution: async () => true });
  const input = { id: skill.id, script: "scripts/check.py", args: [], reason: "Check" };
  await assert.rejects(runner.invoke({ ...input, script: "../other.py" }), /installed Python/);
  await assert.rejects(runner.invoke(input), /Missing dependency/);
  useAssistantSkills.setState({ skills: [{ ...skill, enabled: false }] });
  await assert.rejects(runner.invoke(input), /not enabled/);
});
test("references load separately and tool results preserve their originating call and image", () => {
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDa0AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const input = chatGptInput([
    Message.fromJSON({
      role: "assistant",
      content: [{ toolUse: { toolUseId: "evidence-1", name: "read_skill_file", input: {} } }],
    }),
    Message.fromJSON({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "evidence-1",
            status: "success",
            content: [{ text: "Evidence" }, { image: { format: "png", source: { bytes: png } } }],
          },
        },
      ],
    }),
    Message.fromJSON({
      role: "user",
      content: [{ text: "Compare that evidence to my original image." }],
    }),
  ]);
  assert.equal(input[1].call_id, "evidence-1");
  assert.match(String(input[1].output), /Evidence/);
  assert.doesNotMatch(String(input[1].output), /bytes/);
  const evidence = input[2].content as Record<string, unknown>[];
  assert.match(String(evidence[0].text), /evidence-1/);
  assert.equal(evidence[1].type, "input_image");
  assert.match(String(evidence[1].image_url), /^data:image\/png;base64,/);
  assert.equal(input[3].role, "user");
});

test("the real Strands file tool returns an image block and a transcript preview", async (t) => {
  setup(t);
  const previousBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} }) as ImageBitmap;
  t.after(() => {
    globalThis.createImageBitmap = previousBitmap;
  });
  const session = new ConversationSkills((async (_command, args) =>
    args?.path === "references/check.md"
      ? { text: "Check evidence carefully." }
      : {
          format: "png",
          base64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDa0AAAAASUVORK5CYII=",
        }) as typeof skillCommand);
  const reader = session.tools(deps).find((tool) => tool.name === "read_skill_file")!;
  const context = (path: string) =>
    ({
      toolUse: {
        name: reader.name,
        toolUseId: "read-1",
        input: { id: skill.id, path, output: false },
      },
    }) as unknown as ToolContext;
  const reference = await reader.stream(context("references/check.md")).next();
  assert.equal(reference.done, true);
  assert.equal(reference.value.status, "success");
  assert.equal(reference.value.content[0].type, "textBlock");
  const image = await reader.stream(context("evidence.png")).next();
  assert.equal(image.done, true);
  assert.equal(image.value.status, "success");
  assert.equal(image.value.content[0].type, "imageBlock");
  assert.equal(session.takeEvidence()[0].name, "evidence.png");
  assert.deepEqual(session.takeEvidence(), []);
});
