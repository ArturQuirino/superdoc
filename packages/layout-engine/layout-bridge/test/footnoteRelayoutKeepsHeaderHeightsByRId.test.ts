import { describe, it, expect, vi } from 'vitest';
import type { FlowBlock, Measure } from '@superdoc/contracts';
import type { HeaderFooterConstraints } from '@superdoc/layout-engine';
import * as layoutEngine from '@superdoc/layout-engine';
import { incrementalLayout } from '../src/incrementalLayout';

const makeParagraph = (id: string, text: string, pmStart: number): FlowBlock => ({
  kind: 'paragraph',
  id,
  runs: [{ text, fontFamily: 'Arial', fontSize: 12, pmStart, pmEnd: pmStart + text.length }],
});

const makeMeasure = (lineHeight: number, textLength: number): Measure => ({
  kind: 'paragraph',
  lines: [
    {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: textLength,
      width: 200,
      ascent: lineHeight * 0.8,
      descent: lineHeight * 0.2,
      lineHeight,
    },
  ],
  totalHeight: lineHeight,
});

const makeMultiLineMeasure = (lineHeight: number, lineCount: number): Measure => {
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    fromRun: 0,
    fromChar: i,
    toRun: 0,
    toChar: i + 1,
    width: 200,
    ascent: lineHeight * 0.8,
    descent: lineHeight * 0.2,
    lineHeight,
  }));
  return {
    kind: 'paragraph',
    lines,
    totalHeight: lineCount * lineHeight,
  };
};

/**
 * Footnote reserve relayout must keep headerContentHeightsByRId / footerContentHeightsByRId.
 * Otherwise per-rId header height is dropped, topMargin is not inflated, and body overlaps a tall header.
 */
describe('Footnote relayout preserves headerContentHeightsByRId', () => {
  it('passes by-RId header maps on every layoutDocument call that reserves footnote space', async () => {
    const BODY_LINE_HEIGHT = 20;
    const FOOTNOTE_LINE_HEIGHT = 12;
    const HEADER_CONTENT_HEIGHT = 100;
    const LINES_ON_PAGE_1_WITHOUT_RESERVE = 12;
    const FOOTNOTE_LINES = 5;

    const headerBlock = makeParagraph('hdr-rId1-line', 'Tall header line', 0);

    let pos = 0;
    const bodyBlocks: FlowBlock[] = [];
    for (let i = 0; i < LINES_ON_PAGE_1_WITHOUT_RESERVE; i += 1) {
      const text = `Line ${i + 1}.`;
      bodyBlocks.push(makeParagraph(`body-${i}`, text, pos));
      pos += text.length + 1;
    }
    const refPos = pos - 2;
    const footnoteBlock = makeParagraph(
      'footnote-1-0-paragraph',
      'Footnote content that spans multiple lines here.',
      0,
    );

    const measureBlock = vi.fn(async (block: FlowBlock) => {
      if (block.id.startsWith('hdr-')) {
        return makeMeasure(HEADER_CONTENT_HEIGHT, block.runs?.[0]?.text?.length ?? 1);
      }
      if (block.id.startsWith('footnote-')) {
        return makeMultiLineMeasure(FOOTNOTE_LINE_HEIGHT, FOOTNOTE_LINES);
      }
      const textLength = block.kind === 'paragraph' ? (block.runs?.[0]?.text?.length ?? 1) : 1;
      return makeMeasure(BODY_LINE_HEIGHT, textLength);
    });

    const contentHeight = 240;
    const margins = { top: 72, right: 72, bottom: 72, left: 72, header: 72, footer: 72 };
    const pageHeight = contentHeight + margins.top + margins.bottom;
    const pageWidth = 612;
    const contentWidth = pageWidth - margins.left - margins.right;

    const constraints: HeaderFooterConstraints = {
      width: contentWidth,
      height: margins.top,
      pageWidth,
      pageHeight,
      margins: { left: margins.left, right: margins.right, top: margins.top, bottom: margins.bottom },
    };

    const layoutDocSpy = vi.spyOn(layoutEngine, 'layoutDocument');

    const { layout } = await incrementalLayout(
      [],
      null,
      bodyBlocks,
      {
        pageSize: { w: pageWidth, h: pageHeight },
        margins,
        sectionMetadata: [{ sectionIndex: 0, headerRefs: { default: 'rId1' } }],
        footnotes: {
          refs: [{ id: '1', pos: refPos }],
          blocksById: new Map([['1', [footnoteBlock]]]),
          topPadding: 4,
          dividerHeight: 2,
        },
      },
      measureBlock,
      {
        headerBlocksByRId: new Map([['rId1', [headerBlock]]]),
        constraints,
      },
    );

    const reserveCalls = layoutDocSpy.mock.calls.filter((call) => {
      const opts = call[2] as { footnoteReservedByPageIndex?: number[] };
      return opts?.footnoteReservedByPageIndex?.some((h) => h > 0);
    });
    layoutDocSpy.mockRestore();

    expect(reserveCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of reserveCalls) {
      const opts = call[2] as {
        headerContentHeightsByRId?: Map<string, number>;
      };
      expect(opts.headerContentHeightsByRId).toBeInstanceOf(Map);
      expect(opts.headerContentHeightsByRId?.get('rId1')).toBeGreaterThanOrEqual(HEADER_CONTENT_HEIGHT - 1);
    }

    const page1 = layout.pages[0];
    const headerDistance = page1.margins?.header ?? margins.header;
    const minBodyTop = Math.max(margins.top, headerDistance + HEADER_CONTENT_HEIGHT);
    const firstBody = page1.fragments.find((f) => String(f.blockId).startsWith('body-') && f.kind === 'para');
    expect(firstBody && 'y' in firstBody && typeof firstBody.y === 'number').toBe(true);
    expect((firstBody as { y: number }).y).toBeGreaterThanOrEqual(minBodyTop - 1);
  });
});
