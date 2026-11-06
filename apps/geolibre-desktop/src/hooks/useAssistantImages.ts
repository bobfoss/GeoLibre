import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_IMAGES,
  readAssistantImage,
  validateImageBatch,
  type AssistantImage,
} from "../lib/assistant/images";

/** Drafts are session-only; invalidate asynchronous reads on account/profile changes. */
export function useAssistantImages(scope: string) {
  const [images, setImages] = useState<AssistantImage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const current = useRef<AssistantImage[]>([]);
  const generation = useRef(0);
  const reading = useRef(false);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const clear = useCallback(() => {
    invalidate();
    current.current = [];
    reading.current = false;
    setImages([]);
    setError("");
    setLoading(false);
  }, [invalidate]);
  useEffect(() => {
    clear();
    return invalidate;
  }, [scope, clear, invalidate]);
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    if (reading.current) {
      setError("Images are still preparing. Paste again when they are ready.");
      return;
    }
    const version = generation.current;
    reading.current = true;
    setLoading(true);
    setError("");
    try {
      if (current.current.length + files.length > MAX_IMAGES)
        throw new Error("Attach up to 4 images per message.");
      const added: AssistantImage[] = [];
      for (const file of files) added.push(await readAssistantImage(file));
      if (generation.current !== version) return;
      const next = [...current.current, ...added];
      validateImageBatch(next);
      current.current = next;
      setImages(next);
    } catch (cause) {
      if (generation.current === version)
        setError(cause instanceof Error ? cause.message : "Could not attach this image.");
    } finally {
      if (generation.current === version) {
        reading.current = false;
        setLoading(false);
      }
    }
  };
  const remove = (id: string) => {
    current.current = current.current.filter((image) => image.id !== id);
    setImages(current.current);
    setError("");
  };
  return { images, error, loading, addFiles, remove, clear };
}
