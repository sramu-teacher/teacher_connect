import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

let cachedPdfjs = null;
async function ensurePdfjs() {
  if (!cachedPdfjs) {
    cachedPdfjs = await import("pdfjs-dist");
    cachedPdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  return cachedPdfjs;
}

// Extracts text from a PDF, reconstructing line breaks from each text
// item's vertical position (pdf.js gives a flat stream of positioned
// text runs, not lines). Works well for simple single-column rosters;
// multi-column layouts may interleave — caller should treat the result
// as best-effort. Loads pdf.js on first use rather than at app startup,
// since most page loads never touch a PDF.
export async function extractTextFromPdf(arrayBuffer) {
  const pdfjsLib = await ensurePdfjs();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 1) fullText += "\n";
      fullText += item.str;
      lastY = y;
    }
    fullText += "\n";
  }
  return fullText;
}
