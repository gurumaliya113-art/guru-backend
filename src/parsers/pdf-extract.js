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
  const superMap = {
    "¹": "^1",
    "²": "^2",
    "³": "^3",
    "⁴": "^4",
    "⁵": "^5",
    "⁶": "^6",
    "⁷": "^7",
    "⁸": "^8",
    "⁹": "^9",
    "⁰": "^0",
    "⁺": "^+",
    "⁻": "^-",
    "⁼": "^=",
    "⁽": "^(",
    "⁾": "^)",
  };
  const subMap = {
    "₁": "_1",
    "₂": "_2",
    "₃": "_3",
    "₄": "_4",
    "₅": "_5",
    "₆": "_6",
    "₇": "_7",
    "₈": "_8",
    "₉": "_9",
    "₀": "_0",
    "₊": "_+",
    "₋": "_-",
    "₌": "_=",
    "₍": "_(",
    "₎": "_)",
  };

  return s
    .replace(/\u00ad/g, "")      // soft hyphen
    .replace(/\u200b/g, "")      // zero-width space
    .replace(/\u00a0/g, " ")     // nbsp -> space
    .replace(/[ \t]+/g, " ")
    .replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰⁺⁻⁼⁽⁾]/g, (ch) => superMap[ch] || ch)
    .replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎]/g, (ch) => subMap[ch] || ch);
}

function repairMathNotation(text) {
  return text.replace(/^.*$/gm, (line) => {
    if (!/[=+\-\/]/.test(line)) return line;

    return line
      .replace(/_\{?(\d+)\}?\^([A-Za-z][A-Za-z0-9]*)(?:\^(\d+))?/g, (match, denom, base, exp) => {
        return exp ? `\\frac{${base}^${exp}}{${denom}}` : `\\frac{${base}}{${denom}}`;
      })
      .replace(/([A-Za-z][A-Za-z0-9]*)\^(\d+)_\{?(\d+)\}?/g, (match, base, exp, denom) => {
        return `\\frac{${base}^${exp}}{${denom}}`;
      })
      .replace(/([A-Za-z][A-Za-z0-9]*)_\{?(\d+)\}?\^(\d+)/g, (match, base, denom, exp) => {
        return `\\frac{${base}^${exp}}{${denom}}`;
      })
      .replace(/_\{?(\d+)\}?([A-Za-z][A-Za-z0-9]*)\^(\d+)/g, (match, denom, base, exp) => {
        return `\\frac{${base}^${exp}}{${denom}}`;
      });
  });
}

function getFontSize(item) {
  return Math.abs(item.transform?.[3] || item.transform?.[0] || 1);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function tokensFromLine(parts) {
  if (!parts.length) return "";
  const medianY = median(parts.map((p) => p.y));
  const medianSize = median(parts.map((p) => p.fontSize));
  const SUP_TOLERANCE = Math.max(2, medianSize * 0.2);

  const tokens = [];
  let prevX = null;
  let prevWidth = null;
  for (const part of parts) {
    const dy = part.y - medianY;
    const text = part.str;
    const width = part.width || Math.max(text.length * part.fontSize * 0.4, part.fontSize * 0.5);
    const isSuper = dy > SUP_TOLERANCE && part.fontSize < medianSize * 0.92;
    const isSub = dy < -SUP_TOLERANCE && part.fontSize < medianSize * 0.92;

    if (isSuper && tokens.length > 0) {
      const last = tokens.pop();
      const suffix = text.length === 1 ? `^${text}` : `^{${text}}`;
      tokens.push(last + suffix);
    } else if (isSub && tokens.length > 0) {
      const last = tokens.pop();
      const suffix = text.length === 1 ? `_${text}` : `_{${text}}`;
      tokens.push(last + suffix);
    } else {
      if (prevX !== null && prevWidth !== null) {
        const gap = part.x - (prevX + prevWidth);
        const spaceThreshold = Math.max(part.fontSize * 0.25, 1);
        if (gap > spaceThreshold) tokens.push(" ");
      }
      tokens.push(text);
      prevX = part.x;
      prevWidth = width;
    }
  }
  return tokens.join("");
}

// Reconstruct text from pdfjs textContent items, preserving line breaks
// based on Y-coordinate jumps. Superscripts/subscripts are detected by
// vertical offset and small font size, and attached inline as ^ / _.
function itemsToText(items) {
  if (!items.length) return "";

  const lines = [];
  const Y_TOLERANCE = 10;

  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5];
    const x = it.transform[4];
    const fontSize = getFontSize(it);
    let line = null;
    for (const candidate of lines) {
      if (Math.abs(candidate.y - y) <= Y_TOLERANCE) {
        line = candidate;
        break;
      }
    }
    if (!line) {
      line = { y, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, y, fontSize, str: it.str });
  }

  lines.sort((a, b) => b.y - a.y);

  return lines
    .map((line) => {
      line.parts.sort((a, b) => a.x - b.x);
      return tokensFromLine(line.parts);
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

    // Detect images on this page and extract their bounding boxes
    let hasImage = false;
    let imageBounds = [];
    try {
      const ops = await page.getOperatorList();
      const fnSet = new Set([
        pdf.OPS?.paintImageXObject,
        pdf.OPS?.paintInlineImageXObject,
        pdf.OPS?.paintImageMaskXObject,
      ]);
      
      // Scan operator list for image paint operations
      for (let j = 0; j < ops.fnArray.length; j++) {
        const fn = ops.fnArray[j];
        if (fnSet.has(fn)) {
          hasImage = true;
          // Try to extract CTM (current transformation matrix) which gives position/size
          // For paintImageXObject/paintInlineImageXObject, args typically contain transform matrix
          const args = ops.argsArray[j];
          if (Array.isArray(args) && args.length > 0) {
            // args[0] is often the image object; look for transform matrix in vicinity
            // Store raw args for later processing by render logic
            imageBounds.push({
              fnIndex: j,
              fn,
              args,
              hasRawBounds: true,
            });
          }
        }
      }
    } catch {
      // operator list not critical — skip
    }

    const tc = await page.getTextContent({ includeMarkedContent: false });
    const text = repairMathNotation(normaliseChars(itemsToText(tc.items)));

    pages.push({ 
      pageNumber: i, 
      text, 
      hasImage,
      imageBounds: imageBounds.length > 0 ? imageBounds : null,
    });
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
