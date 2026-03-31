import { describe, expect, it, vi } from 'vitest';
import type { FlowBlock, Layout, Measure, SectionMetadata } from '@superdoc/contracts';
import { layoutPerRIdHeaderFooters } from './HeaderFooterPerRidLayout.js';

vi.mock('@superdoc/measuring-dom', () => ({
  measureBlock: vi.fn(
    async () =>
      ({
        kind: 'paragraph',
        lines: [
          {
            fromRun: 0,
            fromChar: 0,
            toRun: 0,
            toChar: 1,
            width: 100,
            ascent: 10,
            descent: 4,
            lineHeight: 14,
          },
        ],
        totalHeight: 14,
      }) satisfies Measure,
  ),
}));

const makeParagraph = (id: string, text: string): FlowBlock => ({
  kind: 'paragraph',
  id,
  runs: [{ text, fontFamily: 'Arial', fontSize: 12 }],
});

describe('layoutPerRIdHeaderFooters', () => {
  it('lays out first-page header refs per section instead of only default refs in multi-section docs', async () => {
    const deps = {
      headerLayoutsByRId: new Map(),
      footerLayoutsByRId: new Map(),
    };

    const layout: Layout = {
      pageSize: { w: 612, h: 792 },
      pages: [
        { number: 1, fragments: [], sectionIndex: 0 },
        { number: 2, fragments: [], sectionIndex: 0 },
        { number: 3, fragments: [], sectionIndex: 1 },
      ],
    };

    const sectionMetadata: SectionMetadata[] = [
      {
        sectionIndex: 0,
        titlePg: true,
        pageSize: { w: 612, h: 792 },
        margins: { top: 72, right: 72, bottom: 72, left: 72, header: 36 },
        headerRefs: {
          default: 'rId-header-default',
          first: 'rId-header-first',
        },
      },
      {
        sectionIndex: 1,
        titlePg: false,
        pageSize: { w: 612, h: 792 },
        margins: { top: 90, right: 72, bottom: 72, left: 72, header: 24 },
        headerRefs: {
          default: 'rId-header-default',
        },
      },
    ];

    await layoutPerRIdHeaderFooters(
      {
        headerBlocksByRId: new Map([
          ['rId-header-default', [makeParagraph('header-default', 'Default header')]],
          ['rId-header-first', [makeParagraph('header-first', 'First page header')]],
        ]),
        footerBlocksByRId: new Map(),
        constraints: {
          width: 468,
          height: 648,
          pageWidth: 612,
          pageHeight: 792,
          margins: { left: 72, right: 72, top: 72, bottom: 72, header: 36 },
          overflowBaseHeight: 36,
        },
      },
      layout,
      sectionMetadata,
      deps,
    );

    expect(deps.headerLayoutsByRId.has('rId-header-default::s0')).toBe(true);
    expect(deps.headerLayoutsByRId.has('rId-header-first::s0')).toBe(true);
  });

  it('lays out inherited first-page refs for later sections with their own constraints', async () => {
    const deps = {
      headerLayoutsByRId: new Map(),
      footerLayoutsByRId: new Map(),
    };

    const layout: Layout = {
      pageSize: { w: 612, h: 792 },
      pages: [
        { number: 1, fragments: [], sectionIndex: 0 },
        { number: 2, fragments: [], sectionIndex: 1 },
      ],
    };

    const sectionMetadata: SectionMetadata[] = [
      {
        sectionIndex: 0,
        titlePg: true,
        pageSize: { w: 612, h: 792 },
        margins: { top: 72, right: 72, bottom: 72, left: 72, header: 36 },
        headerRefs: {
          default: 'rId-header-default-0',
          first: 'rId-header-first-shared',
        },
      },
      {
        sectionIndex: 1,
        titlePg: true,
        pageSize: { w: 612, h: 792 },
        margins: { top: 90, right: 72, bottom: 72, left: 72, header: 24 },
        headerRefs: {
          default: 'rId-header-default-1',
        },
      },
    ];

    await layoutPerRIdHeaderFooters(
      {
        headerBlocksByRId: new Map([
          ['rId-header-default-0', [makeParagraph('header-default-0', 'Default section 0')]],
          ['rId-header-default-1', [makeParagraph('header-default-1', 'Default section 1')]],
          ['rId-header-first-shared', [makeParagraph('header-first-shared', 'Shared first page header')]],
        ]),
        footerBlocksByRId: new Map(),
        constraints: {
          width: 468,
          height: 648,
          pageWidth: 612,
          pageHeight: 792,
          margins: { left: 72, right: 72, top: 72, bottom: 72, header: 36 },
          overflowBaseHeight: 36,
        },
      },
      layout,
      sectionMetadata,
      deps,
    );

    expect(deps.headerLayoutsByRId.has('rId-header-first-shared::s0')).toBe(true);
    expect(deps.headerLayoutsByRId.has('rId-header-first-shared::s1')).toBe(true);
  });
});
