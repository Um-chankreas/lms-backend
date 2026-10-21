const { sanitize } = require('./libraryToc');

/**
 * Read a photo of a book's contents page into table-of-contents items, with a
 * vision model. Two providers, whichever key is set (Gemini first, because it has a
 * free tier):
 *   GEMINI_API_KEY    Google Gemini (free key from Google AI Studio)
 *   ANTHROPIC_API_KEY Anthropic Claude (paid)
 *
 * The result is only a DRAFT: the portal shows it for the admin to correct
 * before anything is saved, because Khmer print and dot-leaders are easy to
 * misread.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.TOC_MODEL || 'claude-sonnet-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PROMPT = `These images are the table of contents ("មាតិកា") of a Cambodian school textbook. Read every entry and answer with ONLY a JSON object, no prose and no code fences:

{"items":[{"title":"...","page":12,"level":0}]}

Rules:
- Keep each title exactly as printed (Khmer script stays Khmer). Drop dot leaders and the page number from the title.
- "page" is the page number printed beside the entry, as an integer. Convert Khmer digits (០១២៣៤៥៦៧៨៩) to 0-9. Use null if there is none.
- "level": 0 for a chapter or part (ជំពូក, មេរៀន headings), 1 for a lesson or section, 2 for a sub-section.
- Keep the entries in the order they are printed, across all the images.
- If a page is not a table of contents, return {"items":[]}.`;

class TocConfigError extends Error {}

const parseItems = (text) => {
  const json = /\{[\s\S]*\}/.exec(text || '')?.[0];
  if (!json) throw new Error('The reading service did not return a table of contents.');
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error('The reading service returned something unreadable.'); }
  return sanitize(parsed.items);
};

async function readWithGemini(images, key) {
  const parts = [
    ...images.map(({ buffer, mime }) => ({ inline_data: { mime_type: mime, data: buffer.toString('base64') } })),
    { text: PROMPT },
  ];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini returned ${res.status}. ${detail.slice(0, 200)}`);
  }
  const body = await res.json();
  return parseItems((body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
}

async function readWithClaude(images, key) {
  const content = [
    ...images.map(({ buffer, mime }) => ({
      type: 'image',
      source: { type: 'base64', media_type: mime, data: buffer.toString('base64') },
    })),
    { type: 'text', text: PROMPT },
  ];
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`The reading service returned ${res.status}. ${detail.slice(0, 200)}`);
  }
  const body = await res.json();
  return parseItems((body.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
}

/** images: [{ buffer, mime }] (jpeg/png/webp). Returns sanitized draft items. */
async function extractToc(images) {
  if (process.env.GEMINI_API_KEY) return readWithGemini(images, process.env.GEMINI_API_KEY);
  if (process.env.ANTHROPIC_API_KEY) return readWithClaude(images, process.env.ANTHROPIC_API_KEY);
  throw new TocConfigError('Reading a photo needs GEMINI_API_KEY (free) or ANTHROPIC_API_KEY on the server. You can also type or paste the contents instead.');
}

module.exports = { extractToc, TocConfigError };
