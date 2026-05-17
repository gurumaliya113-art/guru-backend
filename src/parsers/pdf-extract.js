// Per-page PDF text extractor using pdfjs-dist directly.
// Why not pdf-parse? Because we need:
//   - per-page text (so each question can be tagged with pageNumber)
//   - proper Unicode handling for subscripts/superscripts (₁ ₂ ³ etc.)
//   - awareness of which pages contain images (for hasFigure detection)
//
// Output:
//   {
//     pages: [{ pageNumber: 1, text, hasImage }, ...],
//     fullText: string,        // all pages joined with "\n\n[PAGE N]\n\n" markers
//     pageCount: number,
//     textLength: number,
//   }

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Map common Unicode subscript / superscript / math chars into ASCII so the
// downstream LLM (Llama / Gemini) sees a stable representation. We KEEP the
// originals when they're already informative — we just normalise weirdness.
function normaliseChars(s) {
  // Most question PDFs already have proper Unicode subscripts; keep them.
  // Just collapse zero-width chars & non-breaking spaces.
  return s
    .replace(/\u00ad/g, "")      // soft hyphen
    .replace(/\u200b/g, "")      // zero-width space
    .replace(/\u00a0/g, " ")     // nbsp -> space
    .replace(/[ \t]+/g, " ");
}

// Reconstruct text from pdfjs textContent items, preserving line breaks
// based on Y-coordinate jumps. Subscripts (smaller font, slight Y-shift)
// are kept inline so "L₁" remains as "L₁" instead of being split.
function itemsToText(items) {
  if (!items.length) return "";

  // Group into lines by Y coordinate
  const lines = [];
  let curLine = null;
  let curY = null;
  const Y_TOLERANCE = 2;

  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5];
    if (curLine === null || Math.abs(y - curY) > Y_TOLERANCE) {
      curLine = { y, parts: [] };
      lines.push(curLine);
      curY = y;
    }
    curLine.parts.push({ x: it.transform[4], str: it.str, hasEol: it.hasEOL });
  }

  // Sort lines top to bottom (PDF Y is bottom-up so larger Y = higher on page)
  lines.sort((a, b) => b.y - a.y);

  return lines
    .map((line) => {
      line.parts.sort((a, b) => a.x - b.x);
      return line.parts.map((p) => p.str).join("");
    })
    .filter((l) => l.trim())
    .join("\n");
}

export async function extractPdfPages(buffer) {
  // pdfjs-dist needs a Uint8Array, not a Node Buffer
  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const pdf = await loadingTask.promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    // Detect images on this page (heuristic: any operator that's an image paint)
    let hasImage = false;
    try {
      const ops = await page.getOperatorList();
      const fnSet = new Set([
        pdf.OPS?.paintImageXObject,
        pdf.OPS?.paintInlineImageXObject,
        pdf.OPS?.paintImageMaskXObject,
      ]);
      for (const fn of ops.fnArray) {
        if (fnSet.has(fn)) { hasImage = true; break; }
      }
    } catch {
      // operator list not critical — skip
    }

    const tc = await page.getTextContent({ includeMarkedContent: false });
    const text = normaliseChars(itemsToText(tc.items));

    pages.push({ pageNumber: i, text, hasImage });
    page.cleanup?.();
  }

  await pdf.cleanup?.();
  await loadingTask.destroy?.();

  const fullText = pages
    .map((p) => `\n\n===== PAGE ${p.pageNumber}${p.hasImage ? " [contains image]" : ""} =====\n\n${p.text}`)
    .join("");

  return {
    pages,
    fullText,
    pageCount: pages.length,
    textLength: fullText.length,
  };
}
