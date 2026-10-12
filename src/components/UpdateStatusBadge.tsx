import i18n from "../i18n";
import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
const t = i18n.t.bind(i18n);
type UpdateStatus = {
  kind: "checking";
} | {
  kind: "latest";
} | {
  kind: "available";
  version: string;
} | {
  kind: "failed";
};
export default function UpdateStatusBadge() {
  const [currentVersion, setCurrentVersion] = useState("0.1.1");
  const [status, setStatus] = useState<UpdateStatus>({
    kind: "checking"
  });
  useEffect(() => {
    let cancelled = false;
    getVersion().then(version => {
      if (!cancelled) setCurrentVersion(version);
    }).catch(() => undefined);
    void check().then(update => {
      if (cancelled) return;
      setStatus(update ? {
        kind: "available",
        version: update.version
      } : {
        kind: "latest"
      });
    }).catch(() => {
      if (!cancelled) setStatus({
        kind: "failed"
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const title = useMemo(() => {
    const base = (() => {
      if (status.kind === "checking") return t("UpdateStatusBadge.0");
      if (status.kind === "latest") return t("UpdateStatusBadge.1");
      if (status.kind === "available") return t("UpdateStatusBadge.3", {
        v0: status.version
      });
      return t("UpdateStatusBadge.2");
    })();
    // 前端产物构建时间：hover 可见，用于核对运行中的 App 是否包含最新修复
    return t("UpdateStatusBadge.4", {
      v0: base,
      v1: __BUILD_STAMP__
    });
  }, [status]);
  return <span className={`brand-version update-status-${status.kind}`} title={title} aria-label={title}>
      <span className="version-breath-light" aria-hidden="true" />
      v{currentVersion}
    </span>;
}