import { RefObject } from "react";
import {
  ActionConfigure,
  ActionDialog,
  ActionDraft,
  ActionExport,
  ActionLayout,
  ActionLoad,
  ActionMerge,
  ActionPrompt,
  ActionSpinner,
  ActionStatus,
  ActionTemplate,
  EmbedActions
} from "../types";

export type UniqueActionProps<T> = Omit<T, "action">;

export const useActions = (iframeRef: RefObject<HTMLIFrameElement | null>) => {
  const sendAction = (
    action: string,
    data: UniqueActionProps<EmbedActions>
  ) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({
        action,
        ...data
      }),
      "*"
    );
  };

  /** 加载图表内容 */
  const load = (data: UniqueActionProps<ActionLoad>) => {
    sendAction("load", data);
  };

  const configure = (data: UniqueActionProps<ActionConfigure>) => {
    sendAction("configure", data);
  };

  /** 把给定 XML 合并进当前文件 */
  const merge = (data: UniqueActionProps<ActionMerge>) => {
    sendAction("merge", data);
  };

  /** 在编辑器窗口展示对话框 */
  const dialog = (data: UniqueActionProps<ActionDialog>) => {
    sendAction("dialog", data);
  };

  const prompt = (data: UniqueActionProps<ActionPrompt>) => {
    sendAction("prompt", data);
  };

  const template = (data: UniqueActionProps<ActionTemplate>) => {
    sendAction("template", data);
  };

  /** 与 Arrange > Layout > Apply 相同格式批量排版 */
  const layout = (data: UniqueActionProps<ActionLayout>) => {
    sendAction("layout", data);
  };

  const draft = (data: UniqueActionProps<ActionDraft>) => {
    sendAction("draft", data);
  };

  const status = (data: UniqueActionProps<ActionStatus>) => {
    sendAction("status", data);
  };

  const spinner = (data: UniqueActionProps<ActionSpinner>) => {
    sendAction("spinner", data);
  };

  const exportDiagram = (data: UniqueActionProps<ActionExport>) => {
    sendAction("export", data);
  };

  return {
    load,
    configure,
    merge,
    dialog,
    prompt,
    template,
    layout,
    draft,
    status,
    spinner,
    exportDiagram
  };
};
