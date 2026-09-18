import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

type UpdateStage =
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export default function UpdatePrompt() {
  const [stage, setStage] = useState<UpdateStage>({ kind: "checking" });
  const [currentVersion, setCurrentVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    getVersion().then((version) => {
      if (!cancelled) setCurrentVersion(version);
    }).catch(() => undefined);
    void check().then((update) => {
      if (!cancelled) setStage(update ? { kind: "available", update } : { kind: "error", message: "当前已是最新版本。" });
    }).catch((error) => {
      if (!cancelled) setStage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const install = async (update: Update) => {
    setStage({ kind: "downloading", version: update.version, percent: 0 });
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setStage({ kind: "downloading", version: update.version, percent: Math.min(99, Math.round((downloaded / total) * 100)) });
          }
        } else if (event.event === "Finished") {
          setStage({ kind: "downloading", version: update.version, percent: 100 });
        }
      });
      setStage({ kind: "ready" });
    } catch (error) {
      setStage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (stage.kind === "checking") return null;

  return (
    <div className="updater-overlay" role="dialog" aria-modal="true">
      <div className="updater-card">
        {stage.kind === "available" ? (
          <>
            <h2>发现新版本 v{stage.update.version}</h2>
            <p>当前版本 v{currentVersion || "未知"}。</p>
            {stage.update.body ? <pre className="updater-notes">{stage.update.body}</pre> : null}
            <div className="updater-actions">
              <button className="ghost-action" onClick={() => setStage({ kind: "error", message: "已跳过本次更新。" })}>稍后</button>
              <button className="primary-action" onClick={() => void install(stage.update)}>立即更新</button>
            </div>
          </>
        ) : null}

        {stage.kind === "downloading" ? (
          <>
            <h2>正在下载 v{stage.version}</h2>
            <p>下载完成后可立即重启安装。</p>
            <div className="updater-progress">
              <span style={{ width: `${stage.percent}%` }} />
            </div>
            <small>{stage.percent}%</small>
          </>
        ) : null}

        {stage.kind === "ready" ? (
          <>
            <h2>更新已就绪</h2>
            <p>重启应用后完成安装。</p>
            <div className="updater-actions">
              <button className="ghost-action" onClick={() => setStage({ kind: "error", message: "更新已安装，稍后重启生效。" })}>稍后</button>
              <button className="primary-action" onClick={() => void relaunch()}>立即重启</button>
            </div>
          </>
        ) : null}

        {stage.kind === "error" ? (
          <>
            <h2>应用更新</h2>
            <p>{stage.message}</p>
            <div className="updater-actions">
              <button className="ghost-action" onClick={() => setStage({ kind: "checking" })}>重试</button>
              <button className="primary-action" onClick={() => setStage({ kind: "checking" })}>关闭</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
