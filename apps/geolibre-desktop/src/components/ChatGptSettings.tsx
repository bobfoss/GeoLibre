import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Select } from "@geolibre/ui";
import {
  chatGptCommand,
  connectionError,
  discoverChatGptModels,
  initializeChatGptConnection,
  refreshChatGptStatus,
  supportsChatGpt,
  useChatGptConnection,
  type ChatGptModelChoice,
} from "../lib/assistant/chatgpt-connection";
import { openExternalLink } from "../lib/open-external";

export function ChatGptModelPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const connection = useChatGptConnection();
  const [models, setModels] = useState<ChatGptModelChoice[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!connection.connected || !connection.permitted) {
      setModels([]);
      return;
    }
    let live = true;
    setLoading(true);
    setError("");
    void discoverChatGptModels()
      .then((choices) => {
        if (!live) return;
        setModels(choices);
        if (!choices.length) setError("No subscription models are available for this account.");
      })
      .catch((cause) => {
        if (live) setError(connectionError(cause).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [connection.connected, connection.permitted, connection.revision, reload]);
  useEffect(() => {
    if (!value && models[0]) onChange(models[0].id);
  }, [value, models, onChange]);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Select
          aria-label={t("assistant.model")}
          value={value}
          disabled={disabled || loading || !connection.permitted}
          onChange={(e) => onChange(e.target.value)}
        >
          {!value && (
            <option value="">
              {t("settings.ai.chatgpt.chooseModel", { defaultValue: "Choose a ChatGPT model" })}
            </option>
          )}
          {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || loading || !connection.permitted}
          onClick={() => setReload((v) => v + 1)}
        >
          {t("settings.ai.refreshModels")}
        </Button>
      </div>
      {loading && <p className="text-xs text-muted-foreground">{t("settings.ai.modelsLoading")}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Account actions are immediate; the parent owns draft profile/model edits. */
export function ChatGptSettings({
  model,
  onModelChange,
}: {
  model: string;
  onModelChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const connection = useChatGptConnection();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void initializeChatGptConnection();
  }, []);
  const run = async (action: "login" | "logout", newAccount = false) => {
    setBusy(action);
    setMessage("");
    try {
      if (action === "login") await chatGptCommand("chatgpt_sign_in", { newAccount });
      else {
        const result = await chatGptCommand("chatgpt_sign_out");
        if (!result.revoked)
          setMessage(
            "Signed out locally. Remote revocation could not be confirmed; disconnect GeoLibre in ChatGPT settings.",
          );
      }
    } catch (cause) {
      setMessage(connectionError(cause).message);
    } finally {
      await refreshChatGptStatus();
      setBusy(null);
    }
  };
  if (!supportsChatGpt())
    return (
      <p>
        {t("settings.ai.chatgpt.windowsOnly", {
          defaultValue: "ChatGPT subscription requires the Windows desktop app.",
        })}
      </p>
    );
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">
        {connection.connected
          ? t("settings.ai.chatgpt.connected", { defaultValue: "Connected to ChatGPT" })
          : t("settings.ai.chatgpt.disconnected", {
              defaultValue: "Connect your ChatGPT subscription",
            })}
      </p>
      {connection.email && <p className="text-xs text-muted-foreground">{connection.email}</p>}
      <p className="text-xs text-muted-foreground">
        {t("settings.ai.chatgpt.usage", {
          defaultValue:
            "Uses your existing ChatGPT plan limits. Sign-in and sign-out take effect immediately. No API key is needed.",
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        {(!connection.connected || !connection.permitted) && (
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("login")}
          >
            {t("settings.ai.chatgpt.continue", { defaultValue: "Continue with ChatGPT" })}
          </Button>
        )}
        {!connection.connected && connection.email && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run("login", true)}
          >
            {t("settings.ai.chatgpt.different", { defaultValue: "Use a different account" })}
          </Button>
        )}
        {connection.connected && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run("logout")}
          >
            {t("settings.ai.chatgpt.signOut", { defaultValue: "Sign out" })}
          </Button>
        )}
        {busy === "login" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void chatGptCommand("chatgpt_cancel", { requestId: "login" }).catch((cause) =>
                setMessage(connectionError(cause).message),
              )
            }
          >
            {t("settings.ai.cancel")}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void openExternalLink("https://chatgpt.com/#settings/Usage")}
        >
          {t("settings.ai.chatgpt.manage", { defaultValue: "Manage ChatGPT usage" })}
        </Button>
      </div>
      {busy === "login" && (
        <p role="status" className="text-xs">
          {t("settings.ai.chatgpt.waiting", { defaultValue: "Complete sign-in in your browser…" })}
        </p>
      )}
      {connection.connected && !connection.permitted && (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.ai.chatgpt.permission", {
            defaultValue: "Connect again and allow GeoLibre to use your ChatGPT plan.",
          })}
        </p>
      )}
      {(message || connection.error) && (
        <p role="alert" className="text-xs text-destructive">
          {message || connection.error}
        </p>
      )}
      {connection.permitted && (
        <ChatGptModelPicker value={model} onChange={onModelChange} disabled={busy !== null} />
      )}
    </div>
  );
}
