import { PDFParse } from "pdf-parse";

function normaliseChars(s) {
  return s
    .replace(/\u00ad/g, "")
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ");
}

export async function extractRawPdfPages(buffer) {
  let parser;

  try {
    // Use the new pdf-parse v2 API and pass buffer data through the options
    // object. The constructor expects a single options object, not a separate
    // pdfjs instance parameter.
    parser = new PDFParse({
      data: buffer,
      verbosity: 0,
    });

    const data = await parser.getText();
    const fullText = (data.text || "").trim();
    
    // Split by common page breaks to estimate per-page text
    // pdf-parse gives us consolidated text, so this is approximate
    const lines = fullText.split("\n");
    const pages = [];
    const pageCount = data.total || data.pages?.length || 0;
    const linesPerPage = Math.max(1, Math.floor(lines.length / Math.max(1, pageCount)));

    for (let i = 0; i < pageCount; i++) {
      const start = i * linesPerPage;
      const end = i === pageCount - 1 ? lines.length : (i + 1) * linesPerPage;
      const pageText = lines.slice(start, end).join("\n");
      pages.push({
        pageNumber: i + 1,
        text: normaliseChars(pageText),
        hasImage: false, // pdf-parse doesn't detect images
      });
    }

    return {
      pages,
      fullText: normaliseChars(fullText),
      pageCount,
      textLength: fullText.length,
    };
  } catch (e) {
    console.error("[extractRawPdfPages] error:", e.message);
    throw e;
  } finally {
    if (parser?.destroy) {
      try {
        await parser.destroy();
      } catch (destroyError) {
        console.error("[extractRawPdfPages] destroy error:", destroyError.message);
      }
    }
  }
}
