export type WholeLineSelection = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type ReviewLineRange = { startLine: number; endLine: number };

export type ReviewTextAnchor = ReviewLineRange & {
  selectedText: string;
  contextBefore: string[];
  contextAfter: string[];
};

export function projectReviewAnchor(anchor: ReviewTextAnchor, content: string, crossingBaseline = false): ReviewLineRange | undefined {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const selectedLines = anchor.selectedText.split('\n');
  if (lines.slice(anchor.startLine - 1, anchor.endLine).join('\n') === anchor.selectedText
    && (!crossingBaseline || reviewAnchorContextMatches(anchor, lines, anchor.startLine - 1, selectedLines.length))) {
    return { startLine: anchor.startLine, endLine: anchor.endLine };
  }

  const matches: number[] = [];
  for (let index = 0; index + selectedLines.length <= lines.length; index++) {
    if (lines.slice(index, index + selectedLines.length).join('\n') !== anchor.selectedText) continue;
    if (reviewAnchorContextMatches(anchor, lines, index, selectedLines.length)) matches.push(index);
    if (matches.length > 1) return undefined;
  }
  if (matches.length !== 1) return undefined;
  const startLine = matches[0] + 1;
  return { startLine, endLine: startLine + selectedLines.length - 1 };
}

function reviewAnchorContextMatches(anchor: ReviewTextAnchor, lines: string[], startIndex: number, selectedLineCount: number) {
  if (!anchor.contextBefore.length && !anchor.contextAfter.length) return startIndex === 0 && selectedLineCount === lines.length;
  const before = lines.slice(Math.max(0, startIndex - anchor.contextBefore.length), startIndex);
  const afterStart = startIndex + selectedLineCount;
  const after = lines.slice(afterStart, afterStart + anchor.contextAfter.length);
  return before.join('\n') === anchor.contextBefore.join('\n') && after.join('\n') === anchor.contextAfter.join('\n');
}

/** Converts a Monaco selection to a 1-based inclusive whole-line range. */
export function reviewSelectionLineRange(selection: WholeLineSelection): ReviewLineRange {
  let startLine = selection.startLineNumber;
  let endLine = selection.endLineNumber;

  if (endLine > startLine && selection.endColumn === 1) endLine -= 1;
  return { startLine, endLine };
}
