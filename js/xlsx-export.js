// MyPayroll-System-V2.0 · xlsx-export.js — Excel downloads (SheetJS, loaded on demand)
const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
export function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = SHEETJS; s.async = true;
    s.onload = () => resolve(window.XLSX); s.onerror = () => reject(new Error('Could not load the spreadsheet writer. Check your internet connection.'));
    document.head.append(s);
  });
}

/**
 * sheets: [{ name, title?:[lines above the table], header:[...], rows:[[...]], total?:[...], widths?:[...] }]
 * Numbers stay numbers (formatted #,##0.00); text stays text (IDs and account numbers are never turned into numbers).
 */
export async function downloadXlsx(fileName, sheets) {
  const XLSX = await loadSheetJS();
  const wb = XLSX.utils.book_new();
  for (const sh of sheets) {
    const aoa = [...(sh.title || []).map((t) => [t]), ...(sh.title?.length ? [[]] : []), sh.header, ...sh.rows, ...(sh.total ? [sh.total] : [])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = (sh.title?.length ? sh.title.length + 2 : 1); r <= range.e.r; r++) for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.t === 'n') cell.z = '#,##0.00';
    }
    ws['!cols'] = (sh.widths || sh.header.map((h) => Math.max(10, String(h).length + 2))).map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
  }
  XLSX.writeFile(wb, fileName);
}
