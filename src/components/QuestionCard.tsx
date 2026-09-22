import { useState } from "react";
import type { RuntimeQuestion } from "../types";

export type UserAnswerSubmission = Array<{ id: string; selected: string[]; custom?: string }>;

/**
 * 运行时问答卡：agent 调用 ask_user_question 挂起等待时展示。
 * 有选项的点选（支持多选），也可填写自定义回答；提交后唤醒挂起的 agent。
 * 与 ApprovalCard（.room-approval）共用视觉语言。
 */
export function QuestionCard({ question, submitting, onSubmit }: {
  question: RuntimeQuestion;
  submitting: boolean;
  onSubmit: (questionId: string, answers: UserAnswerSubmission) => void;
}) {
  // 每个问题的勾选集合与自定义文本
  const [selected, setSelected] = useState<Record<string, string[]>>(() => ({}));
  const [custom, setCustom] = useState<Record<string, string>>(() => ({}));

  const toggleOption = (questionItemId: string, label: string, multiSelect: boolean) => {
    setSelected((current) => {
      const existing = current[questionItemId] || [];
      if (!multiSelect) {
        return { ...current, [questionItemId]: existing.includes(label) ? [] : [label] };
      }
      return {
        ...current,
        [questionItemId]: existing.includes(label)
          ? existing.filter((item) => item !== label)
          : [...existing, label],
      };
    });
  };

  const buildAnswers = (): UserAnswerSubmission | null => {
    const answers: UserAnswerSubmission = [];
    for (const item of question.questions) {
      const chosen = selected[item.id] || [];
      const text = (custom[item.id] || "").trim();
      if (chosen.length === 0 && !text) return null;
      answers.push({ id: item.id, selected: chosen, ...(text ? { custom: text } : {}) });
    }
    return answers;
  };

  const ready = buildAnswers() !== null;

  return (
    <div className="room-approval runtime-question">
      <div className="room-approval-head">
        💬 智能体等待你的回答
        <span className="room-approval-session">（ask_user_question）</span>
      </div>
      <div className="question-list">
        {question.questions.map((item) => (
          <div key={item.id} className="question-item">
            {item.header ? <div className="question-header">{item.header}</div> : null}
            <div className="question-text">{item.question}</div>
            {item.options && item.options.length > 0 ? (
              <div className={`question-options${item.multiSelect ? " multi" : ""}`}>
                {item.options.map((option) => {
                  const active = (selected[item.id] || []).includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`question-option${active ? " active" : ""}`}
                      disabled={submitting}
                      title={option.description || option.label}
                      onClick={() => toggleOption(item.id, option.label, Boolean(item.multiSelect))}
                    >
                      <span className="question-option-label">{option.label}</span>
                      {option.description ? (
                        <span className="question-option-desc">{option.description}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <input
              type="text"
              className="question-custom"
              placeholder="或输入自定义回答…"
              disabled={submitting}
              value={custom[item.id] || ""}
              onChange={(event) => setCustom((current) => ({ ...current, [item.id]: event.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="room-approval-actions">
        <button
          type="button"
          className="primary-action compact"
          disabled={submitting || !ready}
          onClick={() => {
            const answers = buildAnswers();
            if (answers) onSubmit(question.questionId, answers);
          }}
        >
          {submitting ? "提交中…" : "提交回答"}
        </button>
      </div>
    </div>
  );
}
