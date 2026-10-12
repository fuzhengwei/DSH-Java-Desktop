import i18n from "../i18n";
import type { ReactNode } from "react";
import type { RuntimeApproval } from "../types";
const t = i18n.t.bind(i18n);
export type ApprovalVerdict = "ALLOW_ONCE" | "ALLOW_SESSION" | "DENY";

/**
 * 运行时审批卡：普通对话（输入框上方）与数字人房间（消息流内）共用同一视觉与文案。
 * 统一动作：允许一次 / 允许本会话 / 拒绝（与后端 RuntimeApproval 的三个 verdict 一一对应）。
 */
export function ApprovalCard({
  approval,
  resolving,
  onResolve,
  leading
}: {
  approval: RuntimeApproval;
  resolving: boolean;
  onResolve: (verdict: ApprovalVerdict) => void;
  /** 头部前置内容（如数字人头像） */
  leading?: ReactNode;
}) {
  return <div className="room-approval">
      <div className="room-approval-head">
        {leading}{t("ApprovalCard.0")}{approval.toolName ? <span className="room-approval-session" title={approval.sessionId}>（{approval.toolName}）</span> : null}
      </div>
      <div className="room-approval-cmd">
        {approval.displayCommand || (approval.arguments ? JSON.stringify(approval.arguments) : approval.toolName || t("ApprovalCard.1"))}
      </div>
      <div className="room-approval-actions">
        <button type="button" className="primary-action compact" disabled={resolving} onClick={() => onResolve("ALLOW_ONCE")}>
          {resolving ? t("ApprovalCard.2") : t("ApprovalCard.3")}
        </button>
        <button type="button" className="ghost-action compact" disabled={resolving} onClick={() => onResolve("ALLOW_SESSION")}>{t("ApprovalCard.4")}</button>
        <button type="button" className="ghost-action compact danger-text" disabled={resolving} onClick={() => onResolve("DENY")}>{t("ApprovalCard.5")}</button>
      </div>
    </div>;
}