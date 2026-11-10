/**
 * Read one photo of a printed or handwritten maths page into text, with a
 * vision model: Markdown where the words keep their language (Khmer stays
 * Khmer) and the maths is LaTeX in $…$ / $$…$$. Same two providers as
 * tocExtract.js, whichever key is set (Gemini first, it has a free tier):
 *   GEMINI_API_KEY    Google Gemini
 *   ANTHROPIC_API_KEY Anthropic Claude
 *
 * The result is a DRAFT: the portal puts it in the editor for the teacher to
 * check, since small print and handwriting are easy to misread.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.LATEX_OCR_MODEL || process.env.TOC_MODEL || 'claude-sonnet-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PROMPT = `This is a photo of a page from a school maths or science book or worksheet (it may be Khmer, English or both). Transcribe everything on it into Markdown and answer with ONLY the transcription: no commentary and no code fences.

Rules:
- Keep the words exactly as printed, in their own language (Khmer script stays Khmer). Do not translate, summarise or correct them.
- Write every formula as LaTeX: $...$ inside a sentence, and $$...$$ for a formula that stands on its own line.
- Keep the structure: headings as "## ", bold with **, lists as "- " or "1. ", and a blank line between paragraphs.
- Keep the order of the page. Where a figure or diagram appears, write [figure] on its own line.
- If a word or symbol cannot be read, write [?] there. Never invent text that is not on the page.
- If there is no readable text, answer exactly: [no text found]`;

class ReadConfigError extends Error {}

const clean = (text) => String(text || '')
  .replace(/^```(?:markdown|md|latex|tex)?\s*\n?/i, '')
  .replace(/\n?```\s*$/i, '')
  .trim();

async function readWithGemini({ buffer, mime }, key) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: buffer.toString('base64') } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini returned ${res.status}. ${detail.slice(0, 200)}`);
  }
  const body = await res.json();
  return clean((body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
}

async function readWithClaude({ buffer, mime }, key) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`The reading service returned ${res.status}. ${detail.slice(0, 200)}`);
  }
  const body = await res.json();
  return clean((body.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
}

/** image: { buffer, mime } (jpeg/png/webp). Returns the transcription. */
async function imageToLatex(image) {
  if (process.env.GEMINI_API_KEY) return readWithGemini(image, process.env.GEMINI_API_KEY);
  if (process.env.ANTHROPIC_API_KEY) return readWithClaude(image, process.env.ANTHROPIC_API_KEY);
  throw new ReadConfigError('Reading a photo needs GEMINI_API_KEY (free) or ANTHROPIC_API_KEY on the server. You can also type or paste the text instead.');
}

module.exports = { imageToLatex, ReadConfigError };
