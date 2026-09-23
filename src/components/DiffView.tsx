import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { languageFromExtension } from "../lib/markdown-plugins";
import hljs from "highlight.js/lib/common";

/**
 * Git 文件 Diff 视图（VS Code 风格分栏对照）：
 *  - 左旧右新，带两侧行号；未改动行折叠为 "N unchanged lines"；
 *  - 新增文件整体高亮为新增；二进制文件给出占位提示；
 *  - 语法高亮按扩展名（highlight.js），失败回退纯文本。
 *
 * 数据由 Rust 端 project_file_diff 解析 git diff HEAD 提供（含暂存区）。
 */

type FileDiffLine = {
  kind: "add" | "del" | "context";
  oldNo: number | null;
  newNo: number | null;
  text: string;
};

type FileDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: FileDiffLine[];
};

export type FileDiffResult = {
  available: boolean;
  status: string;
  isBinary: boolean;
  insertions: number;
  deletions: number;
  hunks: FileDiffHunk[];
  oldPath?: string | null;
};

/** 连续 context 行超过该数量时折叠 */
const COLLAPSE_CONTEXT_LIMIT = 8;

/** 超大文件保护：diff 行数上限，超出仅渲染前 N 行 */
const MAX_DIFF_ROWS = 12_000;

type DiffRow =
  | { type: "pair"; left: FileDiffLine | null; right: FileDiffLine | null }
  | { type: "collapsed"; count: number; oldNo: number; newNo: number };

/**
 * hunk 内逐块配对成左右两栏：
 *  - del 块与紧随的 add 块按顺序配对（近似行内对照）；
 *  - 多余的一侧独占一行，另一侧留空。
 */
function hunkToRows(hunk: FileDiffHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  const lines = hunk.lines;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      rows.push({ type: "pair", left: line, right: line });
      index += 1;
      continue;
    }
    // 收集连续的 del / add 块
    const dels: FileDiffLine[] = [];
    const adds: FileDiffLine[] = [];
    while (index < lines.length && lines[index].kind === "del") {
      dels.push(lines[index]);
      index += 1;
    }
    while (index < lines.length && lines[index].kind === "add") {
      adds.push(lines[index]);
      index += 1;
    }
    const pairCount = Math.min(dels.length, adds.length);
    for (let pair = 0; pair < pairCount; pair += 1) {
      rows.push({ type: "pair", left: dels[pair], right: adds[pair] });
    }
    for (let rest = pairCount; rest < dels.length; rest += 1) {
      rows.push({ type: "pair", left: dels[rest], right: null });
    }
    for (let rest = pairCount; rest < adds.length; rest += 1) {
      rows.push({ type: "pair", left: null, right: adds[rest] });
    }
  }
  return rows;
}

/** 折叠长 context 块，保留首尾各 3 行 */
function collapseRows(rows: DiffRow[]): DiffRow[] {
  const output: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = () => {
    if (run.length > COLLAPSE_CONTEXT_LIMIT) {
      const head = run.slice(0, 3);
      const tail = run.slice(-3);
      const middle = run.length - 6;
      const first = run[0] as Extract<DiffRow, { type: "pair" }>;
      const last = run[run.length - 1] as Extract<DiffRow, { type: "pair" }>;
      output.push(...head);
      output.push({
        type: "collapsed",
        count: middle,
        oldNo: (first.left?.oldNo ?? 0) + 3,
        newNo: (first.right?.newNo ?? 0) + 3,
      });
      output.push(...tail);
      void last;
    } else {
      output.push(...run);
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === "pair" && row.left && row.right && row.left.kind === "context") {
      run.push(row);
    } else {
      flush();
      output.push(row);
    }
  }
  flush();
  return output;
}

const STATUS_LABEL: Record<string, string> = {
  M: "已修改",
  A: "新增",
  D: "已删除",
  R: "重命名",
};

function DiffCodeText({ text, lang }: { text: string; lang: string | null }) {
  const highlighted = useMemo(() => {
    if (!lang || !hljs.getLanguage(lang)) return null;
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, lang]);
  return highlighted != null
    ? <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    : <code>{text}</code>;
}

function DiffColumn({ lines, side, lang }: { lines: DiffRow[]; side: "left" | "right"; lang: string | null }) {
  return (
    <div className={`diff-col diff-col-${side}`}>
      {lines.map((row, rowIndex) => {
        if (row.type === "collapsed") {
          return (
            <div key={rowIndex} className="diff-row diff-row-collapsed" aria-label={`${row.count} 行未改动`}>
              <span className="diff-line-no" />
              <span className="diff-cell">
                <span className="diff-collapse-label">{row.count} unchanged lines</span>
              </span>
            </div>
          );
        }
        const line = side === "left" ? row.left : row.right;
        const no = line ? (side === "left" ? line.oldNo : line.newNo) : null;
        const kind = line?.kind || "empty";
        return (
          <div key={rowIndex} className={`diff-row diff-kind-${kind}`}>
            <span className="diff-line-no">{no ?? ""}</span>
            <span className="diff-cell">
              {line ? <DiffCodeText text={line.text} lang={lang} /> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type Props = {
  /** 项目/仓库内任意目录路径（用于定位 git 仓库） */
  basePath: string;
  /** 文件绝对路径或仓库相对路径 */
  filePath: string;
};

export function useFileDiff(basePath: string, filePath: string) {
  const [diff, setDiff] = useState<FileDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 轮询文件指纹（mtime + size）：Agent 改写文件后自动重算 diff，
  // 否则「源码 / Diff」切换只反映打开瞬间的状态，改完文件也看不到差异入口。
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    let last = "";
    const poll = () => {
      void invoke<{ mtimeMs: number; size: number } | null>("local_file_stamp", { path: filePath })
        .then((stamp) => {
          if (cancelled || !stamp) return;
          const key = `${stamp.mtimeMs}:${stamp.size}`;
          if (key !== last) {
            const first = last === "";
            last = key;
            // 首次只记录基线指纹；后续变化才触发重算
            if (!first) setDiffVersion((value) => value + 1);
          }
        })
        .catch(() => { /* 文件暂不可访问：忽略，等下一轮 */ });
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [filePath]);

  // diff 结果版本号：文件指纹变化时 +1，驱动下方 effect 重新拉取
  const [diffVersion, setDiffVersion] = useState(0);

  useEffect(() => {
    if (!basePath || !filePath) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void invoke<FileDiffResult>("project_file_diff", { path: basePath, filePath })
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [basePath, filePath, diffVersion]);
  return { diff, loading, error };
}

export function DiffView({ basePath, filePath }: Props) {
  const { diff, loading, error } = useFileDiff(basePath, filePath);
  const lang = useMemo(() => {
    const name = filePath.split("/").filter(Boolean).pop() || filePath;
    const candidate = languageFromExtension(name);
    return candidate && hljs.getLanguage(candidate) ? candidate : null;
  }, [filePath]);

  if (loading) {
    return <div className="diff-view-loading">正在计算 Git 差异…</div>;
  }
  if (error) {
    return <div className="diff-view-error">{error}</div>;
  }
  if (!diff || !diff.available) {
    return <div className="diff-view-empty">该文件当前没有 Git 变更（相对 HEAD）</div>;
  }
  if (diff.isBinary) {
    return (
      <div className="diff-view-empty">
        二进制文件不展示逐行差异（{STATUS_LABEL[diff.status] || diff.status}）
      </div>
    );
  }

  // hunk → 行对 → 折叠，再整体截断保护
  const paired = diff.hunks.flatMap((hunk) => collapseRows(hunkToRows(hunk)));
  const truncated = paired.length > MAX_DIFF_ROWS;
  const rows = truncated ? paired.slice(0, MAX_DIFF_ROWS) : paired;

  return (
    <div className="diff-view">
      <div className="diff-view-meta">
        <span className={`diff-status-badge s-${diff.status}`}>
          {STATUS_LABEL[diff.status] || diff.status}
        </span>
        {diff.oldPath ? <span className="diff-rename-hint">自 {diff.oldPath} 重命名</span> : null}
        <span className="diff-stat">
          <em className="rail-diff-add">+{diff.insertions}</em>
          <em className="rail-diff-del">-{diff.deletions}</em>
        </span>
        <span className="diff-hint">相对 HEAD（含暂存区）</span>
      </div>
      <div className="diff-split">
        <div className="diff-pane">
          <div className="diff-pane-head">旧版本</div>
          <DiffColumn lines={rows} side="left" lang={lang} />
        </div>
        <div className="diff-pane">
          <div className="diff-pane-head">新版本</div>
          <DiffColumn lines={rows} side="right" lang={lang} />
        </div>
      </div>
      {truncated ? (
        <div className="diff-view-truncated">差异过大，仅显示前 {(MAX_DIFF_ROWS / 1000).toFixed(0)}K 行</div>
      ) : null}
    </div>
  );
}
