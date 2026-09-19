import { useActions } from "./hooks/useActions";

export type DrawIoEmbedProps = {
  /** 每次图表变更都会触发 onAutoSave */
  autosave?: boolean;
  /** draw.io embed 基础地址，默认 https://embed.diagrams.net */
  baseUrl?: string;
  /** 参数文档：https://www.drawio.com/doc/faq/embed-mode */
  urlParameters?: UrlParameters;
  /** 预填编辑器的 XML */
  xml?: string;
  /** 预填编辑器的 CSV */
  csv?: string;
  /** 编辑器配置：https://www.drawio.com/doc/faq/configure-diagram-editor */
  configuration?: { [key: string]: any };
  exportFormat?: ExportFormats;
  onLoad?: (data: EventLoad) => void;
  onAutoSave?: (data: EventAutoSave) => void;
  onSave?: (data: EventSave) => void;
  onClose?: (data: EventExit) => void;
  onConfigure?: (data: EventConfigure) => void;
  onMerge?: (data: EventMerge) => void;
  onPrompt?: (data: EventPrompt) => void;
  onTemplate?: (data: EventTemplate) => void;
  onDraft?: (data: EventDraft) => void;
  onExport?: (data: EventExport) => void;
};

export type DrawIoEmbedRef = ReturnType<typeof useActions>;

/** https://www.drawio.com/doc/faq/supported-url-parameters 的常用子集 */
export type UrlParameters = {
  ui?: "min" | "atlas" | "kennedy" | "dark" | "sketch" | "simple";
  dark?: boolean;
  spin?: boolean;
  modified?: boolean;
  keepmodified?: boolean;
  libraries?: boolean;
  noSaveBtn?: boolean;
  saveAndExit?: boolean;
  noExitBtn?: boolean;
  lightbox?: boolean;
  chrome?: boolean;
  target?: string;
  edit?: string;
  grid?: boolean;
  nav?: boolean;
  layers?: boolean;
  "layer-ids"?: string;
  close?: boolean;
  lang?: string;
};

export type ExportFormats = "html" | "html2" | "svg" | "xmlsvg" | "png" | "xmlpng";

export type EmbedEvents =
  | EventInit
  | EventLoad
  | EventAutoSave
  | EventSave
  | EventExit
  | EventConfigure
  | EventMerge
  | EventPrompt
  | EventTemplate
  | EventDraft
  | EventExport;

export type EventInit = {
  event: "init";
};

export type EventLoad = {
  event: "load";
  xml: string;
  scale: number;
};

export type EventSave = {
  event: "save";
  exit?: boolean;
  xml: string;
  /** 当事件由保存动作以外触发时设置 */
  parentEvent?: string;
};

export type EventAutoSave = {
  event: "autosave";
  bounds: PagePosition;
  currentPage: number;
  page: PagePosition;
  pageVisible: boolean;
  scale: number;
  translate: { x: number; y: number };
  xml: string;
};

export type EventExit = {
  event: "exit";
  modified: boolean;
  parentEvent?: string;
};

export type EventConfigure = {
  event: "configure";
};

export type EventMerge = {
  event: "merge";
  error: string;
  message: string;
};

export type EventPrompt = {
  event: "prompt";
  value: string;
  message: ActionPrompt;
};

export type EventTemplate = {
  event: "template";
  xml: string;
  name: string;
  message: ActionTemplate;
  libs?: string;
  builtIn?: boolean;
  blank?: boolean;
};

export type EventDraft = {
  event: "draft";
  error?: string;
  result?: string;
  message: ActionDraft;
};

export type EventExport = {
  event: "export";
  format: ExportFormats;
  message: ActionExport;
  data: string;
  xml: string;
};

export type EmbedActions =
  | ActionLoad
  | ActionMerge
  | ActionConfigure
  | ActionDialog
  | ActionPrompt
  | ActionTemplate
  | ActionLayout;

export type ActionLoad = {
  action: "load";
  xml?: string;
  xmlpng?: string;
  descriptor?: { format: "csv"; data: string };
  autosave?: boolean;
};

export type ActionMerge = {
  action: "merge";
  xml: string;
};

export type ActionConfigure = {
  action: "configure";
  config: { [key: string]: any };
};

export type ActionDialog = {
  action: "dialog";
  title: string;
  message: string;
  button: string;
  modified?: boolean;
};

export type ActionPrompt = {
  action: "prompt";
  title: string;
  ok: string;
  defaultValue: string;
};

export type ActionTemplate = {
  action: "template";
  callback?: boolean;
};

export type ActionLayout = {
  action: "layout";
  layouts: string[];
};

export type ActionDraft = {
  action: "draft";
  xml: string;
  name: string;
  editKey: string;
  discardKey: string;
  ignore: boolean;
};

export type ActionStatus = {
  action: "status";
  message: string;
  modified?: boolean;
};

export type ActionSpinner = {
  action: "spinner";
  message: string;
  show: boolean;
  enabled: boolean;
};

export type ActionExport = {
  action: "export";
  format: ExportFormats;
  data?: string;
  message?: string;
  xml?: string;
  parentEvent?: string;
  spin?: boolean;
  scale?: number;
  layerIds?: string[];
  pageId?: string;
  currentPage?: boolean;
  width?: string;
  border?: string;
  shadow?: boolean;
  grid?: boolean;
  keepTheme?: boolean;
  transparent?: boolean;
  background?: string;
};

type PagePosition = {
  x: number;
  y: number;
  width: number;
  height: number;
};
