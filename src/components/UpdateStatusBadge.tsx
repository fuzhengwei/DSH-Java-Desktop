import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";

type UpdateStatus =
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; version: string }
  | { kind: "failed" };

export default function UpdateStatusBadge() {
  const [currentVersion, setCurrentVersion] = useState("0.1.0");
  const [status, setStatus] = useState<UpdateStatus>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;

    getVersion()
      .then((version) => {
        if (!cancelled) setCurrentVersion(version);
      })
      .catch(() => undefined);

    void check()
      .then((update) => {
        if (cancelled) return;
        setStatus(update ? { kind: "available", version: update.version } : { kind: "latest" });
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const title = useMemo(() => {
    if (status.kind === "checking") return "正在检查更新";
    if (status.kind === "latest") return "当前已是最新版本";
    if (status.kind === "available") return `发现新版本 v${status.version}`;
    return "版本检查失败";
  }, [status]);

  return (
    <span className={`brand-version update-status-${status.kind}`} title={title} aria-label={title}>
      <span className="version-breath-light" aria-hidden="true" />
      v{currentVersion}
    </span>
  );
}
