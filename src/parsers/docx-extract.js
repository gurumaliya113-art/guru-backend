import mammoth from "mammoth";

function normaliseDocxText(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u00a0\u200b\u00ad]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

export async function extractDocxPages(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = normaliseDocxText(result.value || "");
  return {
    pages: [
      {
        pageNumber: 1,
        text,
        hasImage: false,
      },
    ],
    fullText: text,
    pageCount: 1,
    textLength: text.length,
  };
}
