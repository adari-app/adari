// What a selection in the chat is, for "Send selection to…": the rendered
// reply is elements, not its markdown, so the selection's ends say it (each
// end inside a code block's code, or not) and whether it takes in a code block.

import { selectionKindOfEnds, type HandoffSelectionKind } from "../../shared/handoff";

/** The code block body an end of the selection is in, with its language. */
function codeEnd(node: Node | null): { inCode: boolean; language: string | null; block: unknown } {
  const element = node === null ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;
  const body = element?.closest(".md-code-b") ?? null;
  const block = body?.closest(".md-code") ?? null;
  const language = block?.getAttribute("data-lang") ?? "";
  return { inCode: block !== null, language: language === "" ? null : language, block };
}

/** The selection's kind, or null when nothing is selected. */
export function selectionHandoffKind(selection: Selection | null): HandoffSelectionKind | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer;
  const scope = root.nodeType === 1 ? (root as Element) : root.parentElement;
  const inside = scope?.closest(".md-code") !== null && scope?.closest(".md-code") !== undefined;
  const touches = inside || [...(scope?.querySelectorAll(".md-code") ?? [])].some((block) => range.intersectsNode(block));
  return selectionKindOfEnds(codeEnd(range.startContainer), codeEnd(range.endContainer), touches);
}
