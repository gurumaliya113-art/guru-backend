// Render specific PDF pages to PNG buffers using MuPDF (WASM).
// MuPDF is Artifex's industrial-strength PDF engine — it correctly handles
// Type3 fonts, CJK, complex patterns, etc. where pdfjs-dist + @napi-rs/canvas
// reliably crashes on real-world exam papers.
//
// Scale 1.8 ≈ 130 DPI on letter-size pages → crisp diagrams, < 300 KB / page.

import * as mupdf from "mupdf";

/**
 * Render selected pages of a PDF to PNG buffers.
 * @param {Buffer} pdfBuffer - raw PDF bytes
 * @param {number[]} pageNumbers - 1-indexed page numbers to render
 * @param {number} scale - render scale (default 1.8)
 * @returns {Promise<Map<number, Buffer>>}  pageNumber -> PNG Buffer
 */
export async function renderPagesToPng(pdfBuffer, pageNumbers, scale = 1.8) {
  const out = new Map();
  if (!pageNumbers || pageNumbers.length === 0) return out;

  let doc;
  try {
    doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
  } catch (e) {
    console.warn("[pdf-render] failed to open PDF:", e.message);
    return out;
  }

  const total = doc.countPages();
  const unique = [...new Set(pageNumbers.filter((n) => Number.isInteger(n) && n >= 1 && n <= total))];
  const matrix = mupdf.Matrix.scale(scale, scale);

  for (const n of unique) {
    let page;
    let pixmap;
    try {
      page = doc.loadPage(n - 1); // mupdf is 0-indexed
      // Args: (transform, colorspace, alpha, showExtras)
      pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      const png = pixmap.asPNG();
      out.set(n, Buffer.from(png));
    } catch (e) {
      console.warn(`[pdf-render] page ${n} failed:`, e.message);
    } finally {
      try { pixmap?.destroy(); } catch {}
      try { page?.destroy(); } catch {}
    }
  }

  try { doc.destroy(); } catch {}
  return out;
}
