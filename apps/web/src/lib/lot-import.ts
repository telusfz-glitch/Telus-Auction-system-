import ExcelJS from 'exceljs';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_LOTS = 1000;

export interface ImportedLot { lotNumber: string; description: string; quantity: number; startingPrice: number; fallbackIncrement?: number }
export interface ImportResult { lots: ImportedLot[]; errors: string[] }

/** Header aliases (case/spacing-insensitive) → field. */
const HEADERS: Record<string, keyof ImportedLot> = {
  lot: 'lotNumber', lotno: 'lotNumber', lotnumber: 'lotNumber',
  description: 'description', item: 'description', model: 'description',
  qty: 'quantity', quantity: 'quantity', units: 'quantity',
  startingprice: 'startingPrice', startprice: 'startingPrice', reserve: 'startingPrice', startingpriceaed: 'startingPrice',
  fallbackincrement: 'fallbackIncrement', increment: 'fallbackIncrement', minincrement: 'fallbackIncrement',
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** Formula → its cached result; rich text → plain text; dates are not valid in any column. */
function cellValue(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean' || v instanceof Date) return String(v);
  if (typeof v === 'object' && 'result' in v) return cellValue(v.result as ExcelJS.CellValue);
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  return null;
}

/** Money must be exact to the cent. Excel stores 1450.5 as a double; accept it only if it IS a whole number of cents. */
function money(v: string | number | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    const cents = Math.round(v * 100);
    return Math.abs(v * 100 - cents) < 1e-6 ? cents / 100 : null;
  }
  const s = v.replace(/[,\s]/g, '').replace(/^AED/i, '');
  return /^\d{1,10}(\.\d{1,2})?$/.test(s) && Number(s) > 0 ? Number(s) : null;
}

/**
 * Reads the FIRST worksheet of an .xlsx file. Row 1 holds headers: Lot, Description, Quantity, Starting price and,
 * optionally, Fallback increment (other columns are ignored). Every row is checked; nothing is imported if any row fails.
 */
export async function parseLotWorkbook(data: ArrayBuffer): Promise<ImportResult> {
  if (data.byteLength > MAX_IMPORT_BYTES) return { lots: [], errors: ['The file is larger than 2 MB.'] };
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data);
  } catch {
    return { lots: [], errors: ['This is not a readable .xlsx file.'] };
  }
  const ws = wb.worksheets[0];
  if (!ws) return { lots: [], errors: ['The workbook has no worksheet.'] };
  if (ws.actualRowCount > MAX_IMPORT_LOTS + 1) return { lots: [], errors: [`At most ${MAX_IMPORT_LOTS} lots per import.`] };

  const columns = new Map<number, keyof ImportedLot>();
  ws.getRow(1).eachCell((cell, col) => {
    const field = HEADERS[norm(String(cellValue(cell.value) ?? ''))];
    if (field && ![...columns.values()].includes(field)) columns.set(col, field);
  });
  const missing = (['lotNumber', 'description', 'quantity', 'startingPrice'] as const).filter((f) => ![...columns.values()].includes(f));
  if (missing.length) return { lots: [], errors: [`Missing column(s): ${missing.map((m) => ({ lotNumber: 'Lot', description: 'Description', quantity: 'Quantity', startingPrice: 'Starting price' })[m]).join(', ')}.`] };

  const lots: ImportedLot[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw: Partial<Record<keyof ImportedLot, string | number | null>> = {};
    for (const [col, field] of columns) raw[field] = cellValue(row.getCell(col).value);
    if (Object.values(raw).every((v) => v === null || String(v).trim() === '')) continue;   // blank line

    const problems: string[] = [];
    const lotNumber = String(raw.lotNumber ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(lotNumber)) problems.push('lot must be 1–20 letters, digits or dashes');
    else if (seen.has(lotNumber.toLowerCase())) problems.push(`lot ${lotNumber} appears twice`);
    const description = String(raw.description ?? '').trim();
    if (!description || description.length > 500) problems.push('description is required (≤500 characters)');
    const quantity = typeof raw.quantity === 'number' ? raw.quantity : Number(String(raw.quantity ?? '').trim());
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) problems.push('quantity must be a whole number ≥ 1');
    const startingPrice = money(raw.startingPrice ?? null);
    if (startingPrice === null) problems.push('starting price must be a positive amount with at most 2 decimals');
    const hasFallback = raw.fallbackIncrement !== null && raw.fallbackIncrement !== undefined && String(raw.fallbackIncrement).trim() !== '';
    const fallbackIncrement = hasFallback ? money(raw.fallbackIncrement!) : undefined;
    if (fallbackIncrement === null) problems.push('fallback increment must be a positive amount');

    if (problems.length) { errors.push(`Row ${r}: ${problems.join('; ')}.`); continue; }
    seen.add(lotNumber.toLowerCase());
    lots.push({ lotNumber, description, quantity, startingPrice: startingPrice!, ...(fallbackIncrement ? { fallbackIncrement } : {}) });
  }
  if (!lots.length && !errors.length) errors.push('The sheet has no lots.');
  return { lots, errors };
}
