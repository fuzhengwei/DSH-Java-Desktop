import { combineExtensions } from "micromark-util-combine-extensions";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } from "mdast-util-gfm-task-list-item";
import type { Plugin } from "unified";

type ProcessorData = {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
  toMarkdownExtensions?: unknown[];
};

type GfmCompatibleOptions = {
  singleTilde?: boolean;
  firstLineBlank?: boolean;
  tableCellPadding?: boolean;
  tablePipeAlign?: boolean;
  stringLength?: (value: string) => number;
};

const emptyOptions: GfmCompatibleOptions = {};

const remarkGfmCompatible: Plugin<[GfmCompatibleOptions?]> = function remarkGfmCompatible(options?: GfmCompatibleOptions | null) {
  const settings = options || emptyOptions;
  const data = this.data() as ProcessorData;
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);

  micromarkExtensions.push(combineExtensions([
    gfmFootnote(),
    gfmStrikethrough(settings),
    gfmTable(),
    gfmTaskListItem(),
  ]));
  fromMarkdownExtensions.push(
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  );
  toMarkdownExtensions.push({
    extensions: [
      gfmFootnoteToMarkdown(settings),
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown(settings),
      gfmTaskListItemToMarkdown(),
    ],
  });
};

export default remarkGfmCompatible;
