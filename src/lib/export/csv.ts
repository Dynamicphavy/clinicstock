/**
 * CSV export (PapaParse).
 *
 * Takes a ReportTable and returns a string. No DOM, no download, no clock --
 * so the exact bytes a clinic receives can be asserted in a test, which is how
 * brief section 11's "correct filtered data and totals are exported" is
 * actually verified rather than eyeballed.
 */
import Papa from "papaparse";
import type { CellValue, ReportTable } from "@/domain/reports";

/**
 * Excel on Windows assumes the system codepage unless a file begins with a
 * UTF-8 byte order mark. Without it, "Paracetamol 500mg ₦1,200" arrives as
 * mojibake -- and a clinic that sees one corrupted export stops trusting all
 * of them.
 */
const UTF8_BOM = "﻿";

/**
 * PapaParse handles quoting and escaping, which is the entire reason to use it
 * rather than `rows.map(r => r.join(","))`. A product called
 * `Gauze, 10cm (sterile)` or a note containing a quotation mark silently
 * destroys a hand-rolled CSV, shifting every later column by one.
 */
function cell(value: CellValue): string | number {
  if (value === null || value === undefined) return "";
  return value;
}

export interface CsvOptions {
  /** Include the clinic/date/filter preamble above the table. Default true. */
  includeContext?: boolean;
}

export function reportToCsv(table: ReportTable, options: CsvOptions = {}): string {
  const { includeContext = true } = options;
  const matrix: (string | number)[][] = [];

  if (includeContext) {
    // A context block, not a decoration. An exported file outlives the screen
    // it came from: six weeks later, "which clinic, which day, which filters"
    // is the difference between a usable record and a mystery.
    matrix.push([table.title]);
    matrix.push(["Clinic", table.context.clinicName]);
    matrix.push(["Generated", table.context.generatedOn]);
    for (const f of table.context.filters) {
      const [label, ...rest] = f.split(": ");
      matrix.push([label, rest.join(": ")]);
    }
    if (table.footnote) matrix.push(["Note", table.footnote]);
    matrix.push([]); // blank line before the header row
  }

  matrix.push(table.columns.map((c) => c.label));

  for (const row of table.rows) {
    matrix.push(table.columns.map((c) => cell(row[c.key])));
  }

  if (table.totals) {
    matrix.push([]);
    matrix.push(table.columns.map((c) => cell(table.totals![c.key] ?? "")));
  }

  return UTF8_BOM + Papa.unparse(matrix, { newline: "\r\n" });
}

/** Browser-only: hands the file to the user. Separated so the string above
 *  stays testable in Node. */
export function downloadCsv(table: ReportTable, filename: string): void {
  const blob = new Blob([reportToCsv(table)], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename);
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Without this the blob stays in memory for the life of the page. Harmless
  // once; a leak after someone exports forty reports in an afternoon.
  URL.revokeObjectURL(url);
}
