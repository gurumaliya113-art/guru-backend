// Render specific PDF pages to PNG buffers using MuPDF (WASM).
// MuPDF is Artifex's industrial-strength PDF engine — it correctly handles
// Type3 fonts, CJK, complex patterns, etc. where pdfjs-dist + @napi-rs/canvas
// reliably crashes on real-world exam papers.
//
// Scale 1.8 ≈ 130 DPI on letter-size pages → crisp diagrams, < 300 KB / page.
// If figureBounds is provided, renders only the cropped region of the figure.

import * as mupdf from "mupdf";

/**
 * Render selected pages of a PDF to PNG buffers.
 * @param {Buffer} pdfBuffer - raw PDF bytes
 * @param {number[]} pageNumbers - 1-indexed page numbers to render
 * @param {number} scale - render scale (default 1.8)
 * @param {Map<number, Object>} figureBoundsMap - optional; maps pageNumber -> { x0, y0, x1, y1 } for cropped rendering
 * @returns {Promise<Map<number, Buffer>>}  pageNumber -> PNG Buffer
 */
export async function renderPagesToPng(pdfBuffer, pageNumbers, scale = 1.8, figureBoundsMap = null) {
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
      const mediaBounds = page.getBounds();
      
      // If figureBounds provided for this page, render only the cropped region
      let renderBounds = mediaBounds;
      if (figureBoundsMap && figureBoundsMap.has(n)) {
        renderBounds = figureBoundsMap.get(n);
        console.log(`[pdf-render] page ${n}: cropping to figure bounds [${renderBounds[0]}, ${renderBounds[1]}, ${renderBounds[2]}, ${renderBounds[3]}]`);
      }
      
      // Create a pixmap for the (possibly cropped) bounds
      const croppedWidth = (renderBounds[2] - renderBounds[0]) * scale;
      const croppedHeight = (renderBounds[3] - renderBounds[1]) * scale;
      
      // Translate matrix to account for crop offset
      const translateX = -renderBounds[0] * scale;
      const translateY = -renderBounds[1] * scale;
      const cropMatrix = mupdf.Matrix.concat(
        mupdf.Matrix.translate(translateX, translateY),
        matrix
      );
      
      // Args: (transform, colorspace, alpha, showExtras)
      pixmap = page.toPixmap(cropMatrix, mupdf.ColorSpace.DeviceRGB, false, true);
      const png = pixmap.asPNG();
      out.set(n, Buffer.from(png));
      
      if (figureBoundsMap && figureBoundsMap.has(n)) {
        console.log(`[pdf-render] page ${n}: rendered cropped figure (${png.length} bytes)`);
      }
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
