import { useEffect, useState } from "react";
import { Button, Input, Label } from "@geolibre/ui";
import {
  refreshSkills,
  skillCommand,
  skillMetadata,
  supportsSkills,
  useAssistantSkills,
} from "../lib/assistant/skills";

/** The library is app-local and immediate; it is deliberately outside settings exports. */
export function AssistantSkillSettings() {
  const { skills, error } = useAssistantSkills();
  const [source, setSource] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    void refreshSkills().catch(() => {});
  }, []);
  if (!supportsSkills()) return null;
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      await refreshSkills();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Assistant skills">
      <h4 className="text-sm font-semibold">Skills</h4>
      <p className="text-xs text-muted-foreground">
        Install reusable SKILL.md packages, review them, then enable them for the assistant. Changes
        apply immediately and reset the conversation. Skills are shared by your AI profiles on this
        computer.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="skill-source">Public GitHub repository</Label>
        <Input
          id="skill-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="https://github.com/owner/repository"
          disabled={busy}
        />
        <Label htmlFor="skill-folder">
          Skill folder (optional when the repository has one skill)
        </Label>
        <Input
          id="skill-folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="skills/my-skill"
          disabled={busy}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !source.trim()}
          onClick={() =>
            void action(() =>
              skillCommand("assistant_skill_import", {
                source: source.trim(),
                folder: folder.trim(),
              }),
            )
          }
        >
          Import from GitHub
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const selected = await open({
                directory: true,
                multiple: false,
                title: "Select the folder containing SKILL.md",
              });
              if (typeof selected === "string")
                await skillCommand("assistant_skill_import", { source: selected, folder: "" });
            })
          }
        >
          Import local folder
        </Button>
      </div>
      {busy && (
        <p role="status" className="text-xs">
          Updating skill library…
        </p>
      )}
      {(failure || error) && (
        <p role="alert" className="text-xs text-destructive">
          {failure || error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Python scripts ask for approval on every run. They run with your Windows file and network
        access and may install dependencies. Only enable packages you trust. Skill packages and
        working files stay outside exported settings and projects.
      </p>
      {skills.length === 0 && <p className="text-xs text-muted-foreground">No skills installed.</p>}
      {skills.map((skill) => {
        let metadata;
        let invalid = "";
        try {
          metadata = skillMetadata(skill.manifest);
        } catch (cause) {
          invalid = String(cause);
        }
        return (
          <div key={skill.id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm">{metadata?.name ?? "Invalid skill"}</strong>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || (!!invalid && !skill.enabled)}
                  onClick={() =>
                    void action(() =>
                      skillCommand("assistant_skill_enable", {
                        id: skill.id,
                        enabled: !skill.enabled,
                      }),
                    )
                  }
                >
                  {skill.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(() => skillCommand("assistant_skill_remove", { id: skill.id }))
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
            <p className="text-xs">{metadata?.description ?? invalid}</p>
            {metadata?.compatibility && (
              <p className="text-xs">Requirements: {metadata.compatibility}</p>
            )}
            <p className="break-all text-xs text-muted-foreground">{skill.source}</p>
            {metadata?.warnings.map((warning) => (
              <p key={warning} className="text-xs text-muted-foreground">
                {warning}
              </p>
            ))}
            <details className="text-xs">
              <summary className="cursor-pointer">
                Review instructions and {skill.files.length} package files
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                {skill.manifest}
              </pre>
              <ul className="mt-2 max-h-32 overflow-auto">
                {skill.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </details>
            <p className="text-xs text-muted-foreground">
              {skill.enabled
                ? `Available to the assistant. Ask it to use $${metadata?.name}.`
                : "Disabled. Review the package before enabling."}
            </p>
          </div>
        );
      })}
    </section>
  );
}
