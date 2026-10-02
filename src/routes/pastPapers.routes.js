const express = require('express');
const router = express.Router();
const textbookStorage = require('../config/textbookStorage');
const { optionalAuth } = require('../middleware/auth');
const { parsePastPaperName } = require('../utils/pastPaperNames');

/**
 * Past exam papers — the curated BacII revision set in the `past-papers`
 * bucket.
 *
 *   GET /api/past-papers                  every paper, in bucket order
 *   GET /api/past-papers?subject=history  one subject (slug, not the Khmer)
 *   GET /api/past-papers?kind=questions   questions | answers | paper
 *   GET /api/past-papers/:id              one paper, by filename stem
 *
 * Same arrangement as /api/textbooks: no table, the bucket is the catalogue
 * and each filename carries its own metadata (see utils/pastPaperNames.js).
 * It sits in the same other-project storage as the textbooks, so the listing
 * reuses config/textbookStorage.js — the bucket differs, the credentials and
 * project don't.
 *
 * Several papers come as a question/answer pair (01 + 02, 03 + 04). Rather
 * than making the client re-derive that from filenames, each paper carries a
 * link to its counterpart: `answer_paper_id` on the questions,
 * `answers_for_id` on the answers. A client that wants a clean revision list
 * can ask for ?kind=questions and offer the answers behind a tap.
 *
 * Browsing is open (optionalAuth): the bucket is public, so gating the
 * listing would hide the shelf, not the PDFs.
 */

const BUCKET = 'past-papers';

// Hand-uploaded, but asked for on every cold open — see textbooks.routes.js.
const TTL_MS = 60 * 1000;
let cache = { at: 0, papers: null };

const isMissingBucket = (error) =>
  /NoSuchBucket/i.test(error.code || '') || /bucket not found/i.test(error.message || '');

const toPublic = (entry) => {
  const parsed = parsePastPaperName(entry.name);
  if (!parsed) return null;
  return {
    id: parsed.id,
    title: parsed.title,
    subtitle: parsed.subtitle,
    // Khmer display name, matching the Library shelf's heading convention.
    subject: parsed.subject_km,
    subject_slug: parsed.subject_slug,
    subject_en: parsed.subject_en,
    topic_slug: parsed.topic_slug,
    kind: parsed.kind,
    is_answer_key: parsed.is_answer_key,
    years: parsed.years,
    order_number: parsed.order_number,
    file_url: textbookStorage.publicUrl(BUCKET, entry.name),
    // Filled in by linkPairs() below.
    answer_paper_id: null,
    answers_for_id: null,
    cover_url: null,
    page_count: null,
    source: null,
    file_size: entry.size ?? null,
  };
};

/**
 * Point each question paper at its answer key and back again. The two share
 * a topic slug — that's all the filenames give us, so a topic with more than
 * one answer key would link only the first, which is correct until someone
 * uploads a second.
 */
function linkPairs(papers) {
  const answersByTopic = new Map();
  for (const p of papers) {
    if (p.is_answer_key && p.topic_slug && !answersByTopic.has(p.topic_slug)) {
      answersByTopic.set(p.topic_slug, p);
    }
  }
  for (const p of papers) {
    if (p.is_answer_key || !p.topic_slug) continue;
    const answer = answersByTopic.get(p.topic_slug);
    if (!answer) continue;
    p.answer_paper_id = answer.id;
    answer.answers_for_id = p.id;
  }
}

/** Every PDF in the bucket, cached for TTL_MS. */
async function listAll() {
  if (cache.papers && Date.now() - cache.at < TTL_MS) return cache.papers;

  if (!textbookStorage.isConfigured()) {
    console.warn('TEXTBOOK_S3_* not configured — serving an empty past-paper shelf');
    cache = { at: Date.now(), papers: [] };
    return [];
  }

  let entries;
  try {
    entries = await textbookStorage.listBucket(BUCKET);
  } catch (error) {
    if (isMissingBucket(error)) {
      console.warn(`${BUCKET} bucket missing — serving an empty past-paper shelf`);
      cache = { at: Date.now(), papers: [] };
      return [];
    }
    throw error;
  }

  const papers = [];
  for (const entry of entries) {
    const paper = toPublic(entry);
    if (paper) papers.push(paper);
  }

  // The number the uploader put at the front is the intended reading order.
  papers.sort((a, b) => a.order_number - b.order_number || a.id.localeCompare(b.id));
  linkPairs(papers);

  cache = { at: Date.now(), papers };
  return papers;
}

const KINDS = new Set(['questions', 'answers', 'paper']);

/**
 * GET /api/past-papers?subject=&kind=
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    let papers = await listAll();

    if (req.query.subject) {
      const subject = String(req.query.subject).toLowerCase();
      papers = papers.filter(p => p.subject_slug === subject);
    }

    if (req.query.kind) {
      const kind = String(req.query.kind).toLowerCase();
      if (!KINDS.has(kind)) {
        return res.status(400).json({
          success: false,
          error: `kind must be one of: ${[...KINDS].join(', ')}`,
        });
      }
      papers = papers.filter(p => p.kind === kind);
    }

    res.json({ success: true, data: { past_papers: papers } });
  } catch (error) {
    console.error('Past paper list error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch past papers: ' + error.message });
  }
});

/**
 * GET /api/past-papers/:id  — id is the filename without its .pdf
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const papers = await listAll();
    const paper = papers.find(p => p.id === req.params.id);
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Past paper not found' });
    }
    res.json({ success: true, data: { past_paper: paper } });
  } catch (error) {
    console.error('Past paper fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch past paper: ' + error.message });
  }
});

module.exports = router;
