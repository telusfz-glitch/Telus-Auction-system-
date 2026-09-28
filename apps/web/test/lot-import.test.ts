import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseLotWorkbook } from '../src/lib/lot-import';

async function book(rows: unknown[][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Lots');
  rows.forEach((r) => ws.addRow(r));
  const buf = await wb.xlsx.writeBuffer();
  return buf instanceof ArrayBuffer ? buf : new Uint8Array(buf as Buffer).buffer;
}

describe('Excel lot import', () => {
  it('reads the standard layout, with header aliases, formulas, float prices and blank lines', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Lots');
    ws.addRow(['Lot No.', 'Model', 'Qty', 'Starting Price (AED)', 'Min Increment', 'Notes']);
    ws.addRow(['L1', 'iPhone 15 128GB', 10, 1450.5, null, 'ignored']);
    ws.addRow([]);
    ws.addRow(['L2', 'Galaxy S24', { formula: '3*2', result: 6 }, '1,800.00', 25]);
    ws.addRow(['L3', 'Pixel 8', '4', 0.1 + 0.2, null]);
    const buf = await wb.xlsx.writeBuffer();
    const r = await parseLotWorkbook(new Uint8Array(buf as Buffer).buffer as ArrayBuffer);
    expect(r.errors).toEqual([]);
    expect(r.lots).toEqual([
      { lotNumber: 'L1', description: 'iPhone 15 128GB', quantity: 10, startingPrice: 1450.5 },
      { lotNumber: 'L2', description: 'Galaxy S24', quantity: 6, startingPrice: 1800, fallbackIncrement: 25 },
      { lotNumber: 'L3', description: 'Pixel 8', quantity: 4, startingPrice: 0.3 },
    ]);
  });

  it('reports every bad row by number and imports nothing from a sheet with errors', async () => {
    const r = await parseLotWorkbook(await book([
      ['Lot', 'Description', 'Quantity', 'Starting price'],
      ['L1', 'ok', 1, 100],
      ['L1', 'duplicate', 1, 100],
      ['bad lot!', '', 0, 12.345],
      ['L4', 'x', 2.5, -1],
    ]));
    expect(r.errors).toEqual([
      'Row 3: lot L1 appears twice.',
      'Row 4: lot must be 1–20 letters, digits or dashes; description is required (≤500 characters); quantity must be a whole number ≥ 1; starting price must be a positive amount with at most 2 decimals.',
      'Row 5: quantity must be a whole number ≥ 1; starting price must be a positive amount with at most 2 decimals.',
    ]);
  });

  it('rejects missing columns, empty sheets, oversized sheets and non-xlsx data', async () => {
    expect((await parseLotWorkbook(await book([['Lot', 'Description', 'Price']]))).errors).toEqual(['Missing column(s): Quantity, Starting price.']);
    expect((await parseLotWorkbook(await book([['Lot', 'Description', 'Quantity', 'Starting price']]))).errors).toEqual(['The sheet has no lots.']);
    const big = [['Lot', 'Description', 'Quantity', 'Starting price'], ...Array.from({ length: 1001 }, (_, i) => [`L${i}`, 'x', 1, 1])];
    expect((await parseLotWorkbook(await book(big))).errors).toEqual(['At most 1000 lots per import.']);
    expect((await parseLotWorkbook(new TextEncoder().encode('Lot,Description\nL1,x').buffer as ArrayBuffer)).errors).toEqual(['This is not a readable .xlsx file.']);
    expect((await parseLotWorkbook(new ArrayBuffer(3 * 1024 * 1024))).errors).toEqual(['The file is larger than 2 MB.']);
  });
});
