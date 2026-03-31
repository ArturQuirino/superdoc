/** Synthetic block id used for the semantic footnotes heading. */
export const SEMANTIC_FOOTNOTES_HEADING_BLOCK_ID = '__sd_semantic_footnotes_heading';
/** Prefix used for synthetic semantic footnote block ids. */
export const SEMANTIC_FOOTNOTE_BLOCK_ID_PREFIX = '__sd_semantic_footnote';

/**
 * Checks whether a block id belongs to semantic-flow synthetic footnote content.
 *
 * @param blockId - Layout block id to inspect.
 * @returns `true` when the id matches semantic footnote heading/body prefix.
 */
export function isSemanticFootnoteBlockId(blockId: string): boolean {
  return typeof blockId === 'string' && blockId.startsWith(SEMANTIC_FOOTNOTE_BLOCK_ID_PREFIX);
}

/**
 * True when a layout / painted `data-block-id` belongs to the footnote band
 * (DOCX `footnote-*` fragments from FootnotesBuilder, semantic-flow `__sd_semantic_footnote*`
 * bodies — heading included via that prefix — and separators).
 * Use for hit-testing, DomPositionIndex (`isFootnotePaintedBlockHost`), and layout fragment scans.
 */
export function isFootnoteLayoutBlockId(blockId: string | null | undefined): boolean {
  if (typeof blockId !== 'string' || blockId.length === 0) return false;
  return blockId.startsWith('footnote-') || isSemanticFootnoteBlockId(blockId);
}
