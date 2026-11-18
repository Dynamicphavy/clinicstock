/**
 * PDF export (jsPDF).
 *
 * Hand-rolled table rather than jspdf-autotable. The brief's stack lists jsPDF
 * alone, and the layout needed here is a header, a grid and a footer -- adding
 * a plugin to draw rectangles would be a dependency to audit, licence-check
 * and keep updated for something that is about ninety lines.
 *
 * Renders the same ReportTable the screen and the CSV use, so all three agree
 * by construction.
 */
import { jsPDF } from "jspdf";
import type { ReportTable } from "@/domain/reports";

const PAGE = { width: 297, height: 210 };   // A4 landscape, millimetres
const MARGIN = { top: 14, right: 12, bottom: 16, left: 12 };
const ROW_HEIGHT = 6;
const HEADER_HEIGHT = 7;

/** Restrained to match the screen: navy text, one green accent. */
const COLOURS = {
  text: [15, 23, 42] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  accent: [4, 120, 87] as [number, number, number],
  line: [226, 232, 240] as [number, number, number],
  headerFill: [248, 250, 252] as [number, number, number],
};

/**
 * Column widths proportional to content, because a fixed split wastes half the
 * page on a "Days left" column and truncates product names.
 */
function columnWidths(table: ReportTable, available: number): number[] {
  const weights = table.columns.map((c) => {
    const headerLen = c.label.length;
    const sample = table.rows.slice(0, 40);
    const longest = sample.reduce((max, r) => {
      const v = r[c.key];
      return Math.max(max, v === null || v === undefined ? 0 : String(v).length);
    }, 0);
    // Clamped: one long note must not squeeze every other column to nothing.
    return Math.min(Math.max(headerLen, longest, 4), 28);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / total) * available);
}

function truncate(doc: jsPDF, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text;
  let out = text;
  while (out.length > 1 && doc.getTextWidth(out + "…") > width) out = out.slice(0, -1);
  return out + "…";
}

export function reportToPdf(table: ReportTable): jsPDF {
  // Landscape: these tables are wide, and a portrait page would truncate the
  // columns that carry the reasons.
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const usable = PAGE.width - MARGIN.left - MARGIN.right;
  const widths = columnWidths(table, usable);

  let y = MARGIN.top;

  const drawPageHeader = () => {
    doc.setTextColor(...COLOURS.text);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(table.title, MARGIN.left, y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...COLOURS.muted);
    doc.text(table.context.clinicName, PAGE.width - MARGIN.right, y, { align: "right" });
    y += 5;

    // Filters on the page, not just in the UI that produced it. A printed
    // report with no statement of its filters is unreadable a month later.
    const meta = ["Generated " + table.context.generatedOn, ...table.context.filters].join("   ·   ");
    doc.text(truncate(doc, meta, usable), MARGIN.left, y);
    y += 5;

    doc.setDrawColor(...COLOURS.accent);
    doc.setLineWidth(0.5);
    doc.line(MARGIN.left, y, PAGE.width - MARGIN.right, y);
    y += 4;
  };

  const drawColumnHeader = () => {
    doc.setFillColor(...COLOURS.headerFill);
    doc.rect(MARGIN.left, y, usable, HEADER_HEIGHT, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...COLOURS.muted);

    let x = MARGIN.left;
    table.columns.forEach((col, i) => {
      const w = widths[i];
      const pad = 1.5;
      if (col.numeric) {
        doc.text(truncate(doc, col.label, w - pad * 2), x + w - pad, y + 4.8, { align: "right" });
      } else {
        doc.text(truncate(doc, col.label, w - pad * 2), x + pad, y + 4.8);
      }
      x += w;
    });
    y += HEADER_HEIGHT;
  };

  const newPage = () => {
    doc.addPage();
    // No page counter here: the footer loop below reads getNumberOfPages()
    // once the document is complete, because "page 1 of N" cannot be written
    // until N is known.
    y = MARGIN.top;
    drawPageHeader();
    drawColumnHeader();
  };

  drawPageHeader();
  drawColumnHeader();

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);

  const drawRow = (values: (string | number | null)[], bold: boolean) => {
    if (y + ROW_HEIGHT > PAGE.height - MARGIN.bottom) newPage();

    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setTextColor(...COLOURS.text);

    let x = MARGIN.left;
    table.columns.forEach((col, i) => {
      const w = widths[i];
      const pad = 1.5;
      const raw = values[i];
      const text = raw === null || raw === undefined ? "" : String(raw);
      if (text) {
        if (col.numeric) {
          doc.text(truncate(doc, text, w - pad * 2), x + w - pad, y + 4.2, { align: "right" });
        } else {
          doc.text(truncate(doc, text, w - pad * 2), x + pad, y + 4.2);
        }
      }
      x += w;
    });

    doc.setDrawColor(...COLOURS.line);
    doc.setLineWidth(0.1);
    doc.line(MARGIN.left, y + ROW_HEIGHT, PAGE.width - MARGIN.right, y + ROW_HEIGHT);
    y += ROW_HEIGHT;
  };

  if (table.rows.length === 0) {
    doc.setTextColor(...COLOURS.muted);
    doc.text("No records match these filters.", MARGIN.left, y + 5);
    y += ROW_HEIGHT;
  } else {
    for (const row of table.rows) {
      drawRow(table.columns.map((c) => row[c.key] ?? null), false);
    }
  }

  if (table.totals) {
    y += 1;
    doc.setDrawColor(...COLOURS.text);
    doc.setLineWidth(0.3);
    doc.line(MARGIN.left, y, PAGE.width - MARGIN.right, y);
    y += 1;
    drawRow(table.columns.map((c) => table.totals![c.key] ?? null), true);
  }

  if (table.footnote) {
    if (y + 10 > PAGE.height - MARGIN.bottom) newPage();
    y += 3;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.5);
    doc.setTextColor(...COLOURS.muted);
    const lines = doc.splitTextToSize(table.footnote, usable) as string[];
    doc.text(lines, MARGIN.left, y + 3);
  }

  // Page numbers last, once the total is known.
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...COLOURS.muted);
    doc.text(
      "ClinicStock · " + table.context.clinicName + " · page " + i + " of " + total,
      MARGIN.left, PAGE.height - 8,
    );
    doc.text(
      "Stock record, not a clinical or product-safety statement.",
      PAGE.width - MARGIN.right, PAGE.height - 8, { align: "right" },
    );
  }

  return doc;
}

export function downloadPdf(table: ReportTable, filename: string): void {
  reportToPdf(table).save(filename);
}
