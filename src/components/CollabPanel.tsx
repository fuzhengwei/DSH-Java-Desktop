import { memo, useState } from "react";
import type { DigitalHuman, RoomProjection, RuntimeApproval } from "../types";
import type { ServerRoomView } from "../lib/digital-human-client";
import {
  digitalHumanTokensFor,
  reassignRoomTask,
  retryRoomTask,
} from "../lib/digital-human-client";
import { HumanAvatar, PRESENCE_TEXT } from "./DigitalHumanCatalog";
import { PlusIcon, XIcon } from "./icons";
import GroupChatView from "./GroupChatView";

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
    onOpenArtifact?: (artifact: { artifactId?: string; title: string; producerName?: string }) => void;
  };
};

function taskStateLabel(state?: string): string {
  switch ((state || "").toUpperCase()) {
    case "READY": return "待排队";
    case "ASSIGNED": return "已派发";
    case "RUNNING": return "办公中";
    case "WAITING_APPROVAL": return "待审批";
    case "COMPLETED": return "已完成";
    case "FAILED": return "失败";
    case "CANCELED": return "已取消";
    default: return state || "未知";
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
  groupChat,
}: CollabPanelProps) {
  const [view, setView] = useState<"chat" | "info">(groupChat ? "chat" : "info");
  const [busyTaskId, setBusyTaskId] = useState("");
  const humanById = new Map(humans.map((human) => [human.id, human]));
  const participants = (room?.participants || [])
    .map((participant) => ({ participant, human: humanById.get(participant.digitalHumanId) }))
    .filter((entry): entry is { participant: RoomProjection["participants"][number]; human: DigitalHuman } => Boolean(entry.human));
  const serverTasks = groupChat?.serverRoom?.tasks || [];
  const completedTasks = serverTasks.filter((task) => task.state === "COMPLETED").length;
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

  return (
    <div className="collab-panel" aria-label="协作面板">
      {groupChat ? (
        <div className="collab-tabs" role="tablist" aria-label="协作视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={view === "chat"}
            className={`collab-tab${view === "chat" ? " active" : ""}`}
            onClick={() => setView("chat")}
          >
            群聊
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "info"}
            className={`collab-tab${view === "info" ? " active" : ""}`}
            onClick={() => setView("info")}
          >
            工作台
          </button>
        </div>
      ) : null}

      {/* 群聊常驻挂载：切换 Tab 只隐藏不卸载。
          之前条件渲染导致每次切回都重新拉历史/重连 SSE/重渲染整条流，
          表现为"点开一闪一闪地刷内容"。display:none 隐藏期间组件状态与订阅保留 */}
      {groupChat ? (
        <div
          className="collab-chat-slot"
          style={view === "chat" ? undefined : { display: "none" }}
          aria-hidden={view !== "chat"}
        >
          <GroupChatView
            port={groupChat.port}
            roomId={groupChat.roomId}
            humans={humans}
            onFocusItem={groupChat.onFocusItem}
            onOpenArtifact={groupChat.onOpenArtifact}
          />
        </div>
      ) : null}
      {groupChat && view === "chat" ? null : (
        <div className="collab-panel-body">
          <section className="collab-section">
            <div className="collab-section-label">
              当前目标
              <button type="button" className="collab-head-invite" onClick={onInvite} title="加入数字人" aria-label="加入数字人">
                <PlusIcon className="icon-14" />
              </button>
            </div>
            <div className="collab-objective">
              {objective || "发送第一条消息后形成协作目标"}
              <div className="collab-objective-meta">
                <span className={`dh-health-pill ${streaming ? "working" : "on"}`}>
                  {streaming ? "执行中" : participants.length > 0 ? "待命中" : "未开始"}
                </span>
              </div>
            </div>
          </section>

          {groupChat ? (
            <section className="collab-section collab-workbench">
              <div className="collab-section-label">
                工作台
                <span className="collab-count">{serverTasks.length}</span>
              </div>
              <div className="collab-workbench-stats">
                <span><b>{completedTasks}</b><small>已完成</small></span>
                <span><b>{Math.max(serverTasks.length - completedTasks, 0)}</b><small>处理中</small></span>
                <span><b>{artifacts.length}</b><small>产物</small></span>
              </div>
              {serverTasks.length === 0 ? (
                <div className="collab-empty compact">发送任务后，这里会显示数字人的分工、状态和操作。</div>
              ) : (
                <div className="collab-task-list">
                  {serverTasks.map((task) => {
                    const assignee = humans.find((human) => human.id === task.assignedTo);
                    return (
                      <div key={task.taskId} className="collab-task-card">
                        <div className="collab-task-top">
                          <span className={`collab-task-state ${taskStateClass(task.state)}`}>{taskStateLabel(task.state)}</span>
                          <span className="collab-task-title" title={task.title}>{task.title}</span>
                        </div>
                        <div className="collab-task-meta">
                          {assignee ? <HumanAvatar human={assignee} size={22} /> : <span className="collab-task-ghost">?</span>}
                          <span>{task.assigneeName || assignee?.displayName || "未分配"}</span>
                          {task.dependsOn && task.dependsOn.length > 0 ? <small>依赖 {task.dependsOn.length}</small> : null}
                        </div>
                        <div className="collab-task-actions">
                          <button
                            type="button"
                            className="ghost-action compact"
                            disabled={!canRetryTask(task.state) || busyTaskId === task.taskId}
                            onClick={() => void withTokens(
                              (tokens) => retryRoomTask(groupChat.port, groupChat.roomId, task.taskId, groupChat.channelCode, groupChat.approvalMode, tokens),
                              task.taskId,
                            )}
                          >
                            重试
                          </button>
                          <select
                            className="collab-task-select"
                            value=""
                            disabled={busyTaskId === task.taskId || participants.length < 2}
                            onChange={(event) => {
                              const target = event.target.value;
                              if (!target) return;
                              void withTokens(
                                (tokens) => reassignRoomTask(groupChat.port, groupChat.roomId, task.taskId, target, groupChat.channelCode, groupChat.approvalMode, tokens),
                                task.taskId,
                              );
                            }}
                          >
                            <option value="">转派</option>
                            {participants
                              .filter(({ participant }) => participant.digitalHumanId !== task.assignedTo)
                              .map(({ participant, human }) => (
                                <option key={participant.digitalHumanId} value={participant.digitalHumanId}>{human.displayName}</option>
                              ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          <section className="collab-section">
            <div className="collab-section-label">
              参与者 <span className="collab-count">{participants.length}</span>
            </div>
            {participants.length === 0 ? (
              <div className="collab-empty">
                <p>还没有数字人加入</p>
                <button type="button" className="ghost-action compact" onClick={onInvite}>
                  <PlusIcon className="icon-14" />
                  加入数字人
                </button>
                {humans.length === 0 ? (
                  <button type="button" className="collab-link" onClick={onOpenCatalog}>
                    先添加一个数字人 →
                  </button>
                ) : null}
              </div>
            ) : (
              participants.map(({ participant, human }) => (
                <div key={participant.digitalHumanId} className="collab-participant">
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
                  <button
                    type="button"
                    className="collab-remove"
                    title={`把 ${human.displayName} 移出协作`}
                    aria-label={`把 ${human.displayName} 移出协作`}
                    onClick={() => onRemoveParticipant(participant.digitalHumanId)}
                  >
                    <XIcon className="icon-12" />
                  </button>
                </div>
              ))
            )}
          </section>

          {approvals.length > 0 ? (
            <section className="collab-section">
              <div className="collab-section-label">
                等待审批 <span className="collab-count warn">{approvals.length}</span>
              </div>
              {approvals.map((approval) => (
                <div key={approval.approvalId} className="collab-approval">
                  <div className="collab-approval-title">🛡 {approval.toolName || "Tool"}</div>
                  <div className="collab-approval-cmd" title={approval.displayCommand || ""}>
                    {approval.displayCommand || JSON.stringify(approval.arguments || {})}
                  </div>
                  <div className="collab-approval-actions">
                    <button
                      type="button"
                      className="primary-action compact"
                      disabled={Boolean(resolvingApprovalId)}
                      onClick={() => onResolveApproval(approval.approvalId, "ALLOW_ONCE")}
                    >
                      允许
                    </button>
                    <button
                      type="button"
                      className="ghost-action compact danger-text"
                      disabled={Boolean(resolvingApprovalId)}
                      onClick={() => onResolveApproval(approval.approvalId, "DENY")}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
});

export default CollabPanel;
