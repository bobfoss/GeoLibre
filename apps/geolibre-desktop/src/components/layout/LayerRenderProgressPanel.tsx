import type { LayerRenderProgress } from "@geolibre/map";
import { useTranslation } from "react-i18next";
import { Check, Loader2, TriangleAlert } from "lucide-react";

/** Per-layer activity above the map's lower-right controls and attribution. */
export function LayerRenderProgressPanel({ progress }: { progress: LayerRenderProgress[] }) {
  const { t } = useTranslation();
  if (progress.length === 0) return null;
  return (
    <section
      aria-label={t("layerRenderProgress.title")}
      className="pointer-events-auto absolute bottom-12 end-3 z-20 w-72 max-w-[calc(100%-1.5rem)] rounded-lg border bg-background/95 p-3 text-foreground shadow-lg"
    >
      <h2 className="mb-2 text-xs font-semibold">{t("layerRenderProgress.title")}</h2>
      <ul className="max-h-52 space-y-3 overflow-y-auto">
        {progress.map((item) => {
          const complete = item.phase === "complete";
          const failed = item.phase === "error";
          const percent = complete
            ? 100
            : item.phase === "tiles" && item.total > 0
              ? Math.floor((item.loaded / item.total) * 100)
              : undefined;
          const label = t(`layerRenderProgress.${item.phase}`);
          const Icon = complete ? Check : failed ? TriangleAlert : Loader2;
          return (
            <li key={item.layerId} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <Icon
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-destructive" : complete ? "text-emerald-600" : "motion-safe:animate-spin text-primary"}`}
                />
                <span className="min-w-0 flex-1 truncate font-medium" title={item.name}>
                  {item.name}
                </span>
                {percent !== undefined && (
                  <span className="tabular-nums text-muted-foreground">{percent}%</span>
                )}
              </div>
              <div
                role="progressbar"
                aria-label={item.name}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={label}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={`h-full rounded-full ${failed ? "bg-destructive" : complete ? "bg-emerald-600" : "bg-primary"} ${percent === undefined && !failed ? "motion-safe:animate-pulse" : ""}`}
                  style={{ width: `${percent ?? (failed ? 100 : 40)}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {item.phase === "tiles"
                  ? t("layerRenderProgress.tileCount", { loaded: item.loaded, total: item.total })
                  : label}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
