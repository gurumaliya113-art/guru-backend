// Render specific PDF pages to PNG buffers using MuPDF (WASM).
// MuPDF is Artifex's industrial-strength PDF engine — it correctly handles
// Type3 fonts, CJK, complex patterns, etc. where pdfjs-dist + @napi-rs/canvas
// reliably crashes on real-world exam papers.
//
// Scale 1.8 ≈ 130 DPI on letter-size pages → crisp diagrams, < 300 KB / page.
// If figureBounds is provided, renders only the cropped region of the figure.

import * as mupdf from "mupdf";
import { PNG } from "pngjs";
import { createCanvas, loadImage } from "canvas";

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
      const croppedWidth = Math.max(1, Math.round((renderBounds[2] - renderBounds[0]) * scale));
      const croppedHeight = Math.max(1, Math.round((renderBounds[3] - renderBounds[1]) * scale));

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
      let buf = Buffer.from(png);

      // Pixel-fallback: if the cropped bounds produce almost-empty image (white margins),
      // render full page then auto-crop the non-white bbox to avoid saving whole-page scans.
      try {
        const parsed = PNG.sync.read(buf);
        const { width, height, data } = parsed;
        let minX = width, minY = height, maxX = 0, maxY = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
            // consider a pixel non-white if not near-white or not transparent
            if (a > 16 && (r < 250 || g < 250 || b < 250)) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        const area = (maxX - minX + 1) * (maxY - minY + 1);
        if (minX <= maxX && minY <= maxY && area < width * height * 0.95) {
          // crop to bbox
          const canvas = createCanvas(maxX - minX + 1, maxY - minY + 1);
          const ctx = canvas.getContext("2d");
          const img = await loadImage(buf);
          ctx.drawImage(img, -minX, -minY);
          buf = canvas.toBuffer("image/png");
        }
      } catch (e) {
        // keep original buf
      }

      out.set(n, buf);
      
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
