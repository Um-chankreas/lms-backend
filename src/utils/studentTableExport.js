const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');
const { PDFDocument, rgb } = require('pdf-lib');
// fontkit's bundled Khmer/Indic shaper expects this global (it isn't bundled).
if (!global.regeneratorRuntime) global.regeneratorRuntime = require('regenerator-runtime');
const fontkit = require('@pdf-lib/fontkit');

/**
 * CSV / PDF exports of the dashboard's student table. (The Excel version lives
 * in dashboardReport.js.) Every exporter takes the same shape:
 *   groups = [{ title, rows }]  — "All classes" first, then one per class
 * so a single class is just one group.
 */

const STATUS_LABEL = {
  on_track: 'On track', behind: 'Behind', inactive: 'Inactive', not_started: 'Not started', completed: 'Completed',
};
const dateOnly = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');

// A file/sheet-safe version of a class title (keeps Khmer and other Unicode).
function safeName(title, fallback) {
  const cleaned = String(title || '').replace(/[\\/:*?"<>|\[\]\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned || fallback;
}

// Where the student is now, e.g. "Ch 3 · Derivatives".
function lessonLabel(r) {
  if (r.finished) return 'Finished';
  if (r.status === 'not_started') return 'Not started';
  if (r.current_lesson_index == null) return '';
  return `Ch ${r.current_lesson_index} · ${r.current_lesson_title || ''}`.trim();
}

// ── CSV ──────────────────────────────────────────────────────────────────
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  // Stop spreadsheet apps from running a "formula" typed as a name.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function buildCsv(rows, { includeContacts = false } = {}) {
  const head = ['Student', ...(includeContacts ? ['Email', 'Phone'] : []), 'Class', 'Current lesson', 'Progress %', 'Avg quiz %', 'Quizzes taken', 'Last active', 'Days inactive', 'Status'];
  const lines = [head.map(csvCell).join(',')];
  rows.forEach(r => {
    lines.push([
      r.name, ...(includeContacts ? [r.email, r.phone] : []), r.course_title, lessonLabel(r), r.progress, r.avg_quiz,
      `${r.quizzes_attempted}/${r.quizzes_total}`, dateOnly(r.last_active), r.days_inactive, STATUS_LABEL[r.status] || r.status,
    ].map(csvCell).join(','));
  });
  // BOM so Excel opens the UTF-8 (Khmer) text correctly.
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

/** One CSV per group, zipped (used when the export covers every class). */
function buildCsvZip(groups, opts) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    const used = new Set();
    groups.forEach((g, i) => {
      let name = i === 0 ? 'All classes' : safeName(g.title, `Class ${i}`);
      while (used.has(name.toLowerCase())) name += ` (${i})`;
      used.add(name.toLowerCase());
      archive.append(buildCsv(g.rows, opts), { name: `${name}.csv` });
    });
    archive.finalize();
  });
}

// ── PDF ──────────────────────────────────────────────────────────────────
// fontkit's GPOS mark-positioning throws on some Khmer marks (null anchor), so
// those lookups are switched off; the GSUB shaping (stacked subscripts,
// split vowels) still applies and the text stays readable.
const KHMER_FEATURES = { mark: false, mkmk: false, abvm: false, blwm: false, dist: false, curs: false, kern: false };

const FONT_DIR = (pkg) => path.dirname(require.resolve(`${pkg}/package.json`));
const readFont = (pkg, file) => fs.readFileSync(path.join(FONT_DIR(pkg), 'files', file));

const isKhmer = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x1780 && c <= 0x17ff) || (c >= 0x19e0 && c <= 0x19ff);
};

// Split into runs of Khmer / non-Khmer text so each run uses the right font.
// Spaces and punctuation stick to the run before them.
function runsOf(text) {
  const runs = [];
  for (const ch of String(text)) {
    const khmer = isKhmer(ch);
    const neutral = /[\s.,;:!?()\-–—·%/'"0-9]/.test(ch);
    const last = runs[runs.length - 1];
    if (last && (last.khmer === khmer || (neutral && ch !== '​'))) last.text += ch;
    else runs.push({ khmer, text: ch });
  }
  return runs;
}

async function buildPdf(groups, { title = 'Student performance', description = '', includeContacts = false } = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts = {
    latin: await pdf.embedFont(readFont('@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff'), { subset: true }),
    latinBold: await pdf.embedFont(readFont('@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff'), { subset: true }),
    khmer: await pdf.embedFont(readFont('@fontsource/noto-sans-khmer', 'noto-sans-khmer-khmer-400-normal.woff'), { subset: true, features: KHMER_FEATURES }),
    khmerBold: await pdf.embedFont(readFont('@fontsource/noto-sans-khmer', 'noto-sans-khmer-khmer-700-normal.woff'), { subset: true, features: KHMER_FEATURES }),
  };
  const fontFor = (khmer, bold) => fonts[(khmer ? 'khmer' : 'latin') + (bold ? 'Bold' : '')];

  const measure = (text, size, bold) =>
    runsOf(text).reduce((w, r) => w + fontFor(r.khmer, bold).widthOfTextAtSize(r.text, size), 0);

  // Characters a font can't draw (rare symbols) are dropped rather than crashing.
  const drawText = (page, text, x, y, size, { bold = false, color = rgb(0.12, 0.16, 0.14) } = {}) => {
    let cx = x;
    runsOf(text).forEach(r => {
      const font = fontFor(r.khmer, bold);
      let t = r.text;
      try { font.widthOfTextAtSize(t, size); } catch {
        t = [...t].filter(ch => { try { font.widthOfTextAtSize(ch, size); return true; } catch { return false; } }).join('');
      }
      if (!t) return;
      page.drawText(t, { x: cx, y, size, font, color });
      cx += font.widthOfTextAtSize(t, size);
    });
  };

  const fit = (text, maxW, size, bold) => {
    let t = String(text ?? '');
    if (measure(t, size, bold) <= maxW) return t;
    const chars = [...t];
    while (chars.length > 1 && measure(chars.join('') + '…', size, bold) > maxW) chars.pop();
    return chars.join('') + '…';
  };

  const PAGE_W = 842, PAGE_H = 595, MARGIN = 36;
  const cols = [
    { key: 'name', label: 'Student', w: includeContacts ? 120 : 160 },
    ...(includeContacts ? [{ key: 'email', label: 'Email', w: 130 }, { key: 'phone', label: 'Phone', w: 80 }] : []),
    { key: 'course', label: 'Class', w: includeContacts ? 120 : 170 },
    { key: 'progress', label: 'Progress', w: 60, right: true },
    { key: 'avg', label: 'Avg quiz', w: 58, right: true },
    { key: 'quizzes', label: 'Quizzes', w: 58, right: true },
    { key: 'last', label: 'Last active', w: 80 },
    { key: 'status', label: 'Status', w: 70 },
  ];
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const scale = (PAGE_W - MARGIN * 2) / totalW;
  cols.forEach(c => { c.w *= scale; });
  const ROW_H = 20, HEAD_H = 22, SIZE = 8.5;
  const GREEN = rgb(0.118, 0.42, 0.243);
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const cellText = (r, key) => {
    switch (key) {
      case 'name': return r.name || '—';
      case 'email': return r.email || '';
      case 'phone': return r.phone || '';
      case 'course': return r.course_title || '—';
      case 'progress': return `${r.progress}%`;
      case 'avg': return r.avg_quiz != null ? `${r.avg_quiz}%` : '—';
      case 'quizzes': return `${r.quizzes_attempted}/${r.quizzes_total}`;
      case 'last': return r.days_inactive == null ? '—' : r.days_inactive === 0 ? 'Today' : r.days_inactive === 1 ? 'Yesterday' : `${r.days_inactive} days ago`;
      case 'status': return STATUS_LABEL[r.status] || r.status;
      default: return '';
    }
  };

  groups.forEach((group, gi) => {
    let page = null;
    let y = 0;
    let pageNo = 0;
    const header = () => {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      pageNo += 1;
      y = PAGE_H - MARGIN;
      if (pageNo === 1) {
        drawText(page, `${title} · ${gi === 0 && groups.length > 1 ? 'All classes' : group.title}`, MARGIN, y - 14, 15, { bold: true, color: GREEN });
        drawText(page, `${description ? description + ' · ' : ''}${group.rows.length} rows · Generated ${generated}`, MARGIN, y - 32, 8.5, { color: rgb(0.36, 0.42, 0.38) });
        y -= 52;
      } else {
        drawText(page, `${group.title} (continued)`, MARGIN, y - 10, 10, { bold: true, color: GREEN });
        y -= 26;
      }
      page.drawRectangle({ x: MARGIN, y: y - HEAD_H, width: PAGE_W - MARGIN * 2, height: HEAD_H, color: GREEN });
      let x = MARGIN;
      cols.forEach(c => {
        const tx = c.right ? x + c.w - 6 - measure(c.label, SIZE, true) : x + 6;
        drawText(page, c.label, tx, y - 14.5, SIZE, { bold: true, color: rgb(1, 1, 1) });
        x += c.w;
      });
      y -= HEAD_H;
    };

    header();
    if (group.rows.length === 0) {
      drawText(page, 'No students match these filters.', MARGIN + 6, y - 16, 9, { color: rgb(0.36, 0.42, 0.38) });
    }
    group.rows.forEach((r, i) => {
      if (y - ROW_H < MARGIN + 14) header();
      if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: PAGE_W - MARGIN * 2, height: ROW_H, color: rgb(0.965, 0.973, 0.969) });
      let x = MARGIN;
      cols.forEach(c => {
        const text = fit(cellText(r, c.key), c.w - 12, SIZE, false);
        const tx = c.right ? x + c.w - 6 - measure(text, SIZE, false) : x + 6;
        drawText(page, text, tx, y - 13.5, SIZE, c.key === 'name' ? { bold: true } : {});
        x += c.w;
      });
      y -= ROW_H;
    });
  });

  // Footer with page numbers on every page.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `Romduol Scholars · page ${i + 1} of ${pages.length}`;
    drawText(p, label, PAGE_W - MARGIN - measure(label, 7.5, false), 20, 7.5, { color: rgb(0.45, 0.5, 0.47) });
  });
  return Buffer.from(await pdf.save());
}

module.exports = { buildCsv, buildCsvZip, buildPdf, safeName };
