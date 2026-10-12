import i18n from "../i18n";
import { memo, useState } from "react";
import type { DigitalHuman, RoomProjection, RuntimeApproval } from "../types";
import type { ServerRoomView } from "../lib/digital-human-client";
import { digitalHumanTokensFor, reassignRoomTask, retryRoomTask } from "../lib/digital-human-client";
import { HumanAvatar, PRESENCE_TEXT } from "./DigitalHumanCatalog";
import { PlusIcon, XIcon } from "./icons";
import GroupChatView from "./GroupChatView";
const t = i18n.t.bind(i18n);
type CollabPanelProps = {
  room: RoomProjection | null;
  humans: DigitalHuman[];
  objective?: string;
  streaming: boolean;
  approvals: RuntimeApproval[];
  resolvingApprovalId: string;
  onResolveApproval: (approvalId: string, verdict: "ALLOW_ONCE" | "ALLOW_SESSION" | "DENY") => void;
  onInvite: () => void;
  onRemoveParticipant: (digitalHumanId: string) => void;
  onOpenCatalog: () => void;
  /** 服务端房间就绪后启用「群聊」视图（微信群式简化叙事） */
  groupChat?: {
    port: number;
    roomId: string;
    serverRoom: ServerRoomView | null;
    channelCode?: string;
    approvalMode?: string;
    onFocusItem?: (seq: number) => void;
    onOpenArtifact?: (artifact: {
      artifactId?: string;
      title: string;
      producerName?: string;
    }) => void;
  };
};
function taskStateLabel(state?: string): string {
  switch ((state || "").toUpperCase()) {
    case "READY":
      return t("CollabPanel.0");
    case "ASSIGNED":
      return t("CollabPanel.1");
    case "RUNNING":
      return t("CollabPanel.2");
    case "WAITING_APPROVAL":
      return t("CollabPanel.3");
    case "COMPLETED":
      return t("CollabPanel.4");
    case "FAILED":
      return t("CollabPanel.5");
    case "CANCELED":
      return t("CollabPanel.6");
    default:
      return state || t("CollabPanel.7");
  }
}
function taskStateClass(state?: string): string {
  const normalized = (state || "unknown").toLowerCase();
  if (["ready", "assigned"].includes(normalized)) return "queued";
  if (["running"].includes(normalized)) return "running";
  if (["waiting_approval"].includes(normalized)) return "waiting";
  if (["completed"].includes(normalized)) return "done";
  if (["failed", "canceled"].includes(normalized)) return "error";
  return "queued";
}
function canRetryTask(state?: string): boolean {
  return ["FAILED", "CANCELED", "COMPLETED"].includes((state || "").toUpperCase());
}

/**
 * 右侧协作面板：两个视图
 * - 群聊：微信群式简化叙事（要干啥 / 谁在干啥 / 谁圈谁 / 接下来谁做），点击摘要在中间区域看详情；
 * - 信息：目标 / 参与者 / 审批的结构化管理。
 */
const CollabPanel = memo(function CollabPanel({
  room,
  humans,
  objective,
  streaming,
  approvals,
  resolvingApprovalId,
  onResolveApproval,
  onInvite,
  onRemoveParticipant,
  onOpenCatalog,
  groupChat
}: CollabPanelProps) {
  const [view, setView] = useState<"chat" | "info">(groupChat ? "chat" : "info");
  const [busyTaskId, setBusyTaskId] = useState("");
  const humanById = new Map(humans.map(human => [human.id, human]));
  const participants = (room?.participants || []).map(participant => ({
    participant,
    human: humanById.get(participant.digitalHumanId)
  })).filter((entry): entry is {
    participant: RoomProjection["participants"][number];
    human: DigitalHuman;
  } => Boolean(entry.human));
  const serverTasks = groupChat?.serverRoom?.tasks || [];
  const completedTasks = serverTasks.filter(task => task.state === "COMPLETED").length;
  const artifacts = groupChat?.serverRoom?.artifacts || [];
  const withTokens = async (action: (tokens: Record<string, string>) => Promise<void>, taskId: string) => {
    if (!groupChat) return;
    setBusyTaskId(taskId);
    try {
      const tokens = await digitalHumanTokensFor(humans);
      await action(tokens);
    } finally {
      setBusyTaskId("");
    }
  };
  return <div className="collab-panel" aria-label={t("CollabPanel.8")}>
      {groupChat ? <div className="collab-tabs" role="tablist" aria-label={t("CollabPanel.9")}>
          <button type="button" role="tab" aria-selected={view === "chat"} className={`collab-tab${view === "chat" ? " active" : ""}`} onClick={() => setView("chat")}>{t("CollabPanel.10")}</button>
          <button type="button" role="tab" aria-selected={view === "info"} className={`collab-tab${view === "info" ? " active" : ""}`} onClick={() => setView("info")}>{t("CollabPanel.11")}</button>
        </div> : null}

      {/* 群聊常驻挂载：切换 Tab 只隐藏不卸载。
          之前条件渲染导致每次切回都重新拉历史/重连 SSE/重渲染整条流，
          表现为"点开一闪一闪地刷内容"。display:none 隐藏期间组件状态与订阅保留 */}
      {groupChat ? <div className="collab-chat-slot" style={view === "chat" ? undefined : {
      display: "none"
    }} aria-hidden={view !== "chat"}>
          <GroupChatView port={groupChat.port} roomId={groupChat.roomId} humans={humans} onFocusItem={groupChat.onFocusItem} onOpenArtifact={groupChat.onOpenArtifact} serverRoom={groupChat.serverRoom} />
        </div> : null}
      {groupChat && view === "chat" ? null : <div className="collab-panel-body">
          <section className="collab-section">
            <div className="collab-section-label">{t("CollabPanel.12")}<button type="button" className="collab-head-invite" onClick={onInvite} title={t("CollabPanel.13")} aria-label={t("CollabPanel.14")}>
                <PlusIcon className="icon-14" />
              </button>
            </div>
            <div className="collab-objective">
              {objective || t("CollabPanel.15")}
              <div className="collab-objective-meta">
                <span className={`dh-health-pill ${streaming ? "working" : "on"}`}>
                  {streaming ? t("CollabPanel.16") : participants.length > 0 ? t("CollabPanel.17") : t("CollabPanel.18")}
                </span>
              </div>
            </div>
          </section>

          {groupChat ? <section className="collab-section collab-workbench">
              <div className="collab-section-label">{t("CollabPanel.19")}<span className="collab-count">{serverTasks.length}</span>
              </div>
              <div className="collab-workbench-stats">
                <span><b>{completedTasks}</b><small>{t("CollabPanel.20")}</small></span>
                <span><b>{Math.max(serverTasks.length - completedTasks, 0)}</b><small>{t("CollabPanel.21")}</small></span>
                <span><b>{artifacts.length}</b><small>{t("CollabPanel.22")}</small></span>
              </div>
              {serverTasks.length === 0 ? <div className="collab-empty compact">{t("CollabPanel.23")}</div> : <div className="collab-task-list">
                  {serverTasks.map(task => {
            const assignee = humans.find(human => human.id === task.assignedTo);
            return <div key={task.taskId} className="collab-task-card">
                        <div className="collab-task-top">
                          <span className={`collab-task-state ${taskStateClass(task.state)}`}>{taskStateLabel(task.state)}</span>
                          <span className="collab-task-title" title={task.title}>{task.title}</span>
                        </div>
                        <div className="collab-task-meta">
                          {assignee ? <HumanAvatar human={assignee} size={22} /> : <span className="collab-task-ghost">?</span>}
                          <span>{task.assigneeName || assignee?.displayName || t("CollabPanel.24")}</span>
                          {task.dependsOn && task.dependsOn.length > 0 ? <small>{t("CollabPanel.25")}{task.dependsOn.length}</small> : null}
                        </div>
                        <div className="collab-task-actions">
                          <button type="button" className="ghost-action compact" disabled={!canRetryTask(task.state) || busyTaskId === task.taskId} onClick={() => void withTokens(tokens => retryRoomTask(groupChat.port, groupChat.roomId, task.taskId, groupChat.channelCode, groupChat.approvalMode, tokens), task.taskId)}>{t("CollabPanel.26")}</button>
                          <select className="collab-task-select" value="" disabled={busyTaskId === task.taskId || participants.length < 2} onChange={event => {
                  const target = event.target.value;
                  if (!target) return;
                  void withTokens(tokens => reassignRoomTask(groupChat.port, groupChat.roomId, task.taskId, target, groupChat.channelCode, groupChat.approvalMode, tokens), task.taskId);
                }}>
                            <option value="">{t("CollabPanel.27")}</option>
                            {participants.filter(({
                    participant
                  }) => participant.digitalHumanId !== task.assignedTo).map(({
                    participant,
                    human
                  }) => <option key={participant.digitalHumanId} value={participant.digitalHumanId}>{human.displayName}</option>)}
                          </select>
                        </div>
                      </div>;
          })}
                </div>}
            </section> : null}

          <section className="collab-section">
            <div className="collab-section-label">{t("CollabPanel.28")}<span className="collab-count">{participants.length}</span>
            </div>
            {participants.length === 0 ? <div className="collab-empty">
                <p>{t("CollabPanel.29")}</p>
                <button type="button" className="ghost-action compact" onClick={onInvite}>
                  <PlusIcon className="icon-14" />{t("CollabPanel.30")}</button>
                {humans.length === 0 ? <button type="button" className="collab-link" onClick={onOpenCatalog}>{t("CollabPanel.31")}</button> : null}
              </div> : participants.map(({
          participant,
          human
        }) => <div key={participant.digitalHumanId} className="collab-participant">
                  <HumanAvatar human={human} size={32} presence={participant.presence} />
                  <div className="collab-participant-main">
                    <div className="collab-participant-name">{human.displayName}</div>
                    <div className="collab-participant-task">
                      {participant.activeTaskLabel || PRESENCE_TEXT[participant.presence]}
                    </div>
                  </div>
                  <span className={`collab-presence presence-text-${participant.presence}`}>
                    {PRESENCE_TEXT[participant.presence]}
                  </span>
                  <button type="button" className="collab-remove" title={t("CollabPanel.35", {
            v0: human.displayName
          })} aria-label={t("CollabPanel.36", {
            v0: human.displayName
          })} onClick={() => onRemoveParticipant(participant.digitalHumanId)}>
                    <XIcon className="icon-12" />
                  </button>
                </div>)}
          </section>

          {approvals.length > 0 ? <section className="collab-section">
              <div className="collab-section-label">{t("CollabPanel.32")}<span className="collab-count warn">{approvals.length}</span>
              </div>
              {approvals.map(approval => <div key={approval.approvalId} className="collab-approval">
                  <div className="collab-approval-title">🛡 {approval.toolName || "Tool"}</div>
                  <div className="collab-approval-cmd" title={approval.displayCommand || ""}>
                    {approval.displayCommand || JSON.stringify(approval.arguments || {})}
                  </div>
                  <div className="collab-approval-actions">
                    <button type="button" className="primary-action compact" disabled={Boolean(resolvingApprovalId)} onClick={() => onResolveApproval(approval.approvalId, "ALLOW_ONCE")}>{t("CollabPanel.33")}</button>
                    <button type="button" className="ghost-action compact danger-text" disabled={Boolean(resolvingApprovalId)} onClick={() => onResolveApproval(approval.approvalId, "DENY")}>{t("CollabPanel.34")}</button>
                  </div>
                </div>)}
            </section> : null}
        </div>}
    </div>;
});
export default CollabPanel;