/** Position the picker under the text caret without a viewport-dependent flip. */
export function socialMentionPopupPlacement(
  caret: { left: number; bottom: number },
  dialog: { left: number; bottom: number; width: number; top: number },
  viewportBottom: number,
) {
  const availableBelow = Math.min(dialog.bottom, viewportBottom) - caret.bottom - 12;
  const width = Math.min(480, Math.max(0, dialog.width - 24));
  return {
    left: Math.max(12, Math.min(caret.left - dialog.left, dialog.width - width - 12)),
    top: caret.bottom - dialog.top + 6,
    width,
    maxHeight: Math.max(0, Math.min(260, availableBelow)),
    availableBelow,
  };
}
