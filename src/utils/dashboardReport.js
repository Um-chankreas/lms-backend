const ExcelJS = require('exceljs');
const sharp = require('sharp');
const path = require('path');

/**
 * Builds the dashboard Excel report: data sheets plus a "Charts" sheet whose
 * charts are drawn as SVG and rasterised to PNG with sharp, then embedded as
 * pictures (they look like the dashboard but are not editable in Excel).
 */

const GREEN = '#1E6B3E';
const MINT = '#1FBF84';
const INK = '#1F2A24';
const MUTED = '#5B6B62';
const GRID = '#E4E9E6';
const FONT = 'DejaVu Sans, Arial, sans-serif';
const W = 700;
const H = 360;

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, t, { size = 11, anchor = 'start', weight = 400, fill = INK } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${esc(t)}</text>`;

const frame = (title, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<rect width="${W}" height="${H}" fill="#fff"/>` +
  text(W / 2, 28, title, { size: 15, anchor: 'middle', weight: 700 }) +
  inner +
  '</svg>';

const niceMax = (max) => {
  if (max <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / pow) * pow;
};

// Shared plot area for column / line / bar charts.
const PLOT = { l: 56, r: W - 24, t: 52, b: H - 56 };
const yOf = (v, max) => PLOT.b - (v / max) * (PLOT.b - PLOT.t);

function axes(max) {
  let out = '';
  for (let i = 0; i <= 5; i++) {
    const v = (max / 5) * i;
    const y = yOf(v, max);
    out += `<line x1="${PLOT.l}" x2="${PLOT.r}" y1="${y}" y2="${y}" stroke="${GRID}"/>`;
    out += text(PLOT.l - 8, y + 4, Math.round(v), { size: 10, anchor: 'end', fill: MUTED });
  }
  return out;
}

function pieSvg(title, slices) {
  const data = slices.filter(s => s.value > 0);
  const total = data.reduce((a, s) => a + s.value, 0);
  const cx = 210, cy = 205, r = 120;
  let inner = '';
  if (total === 0) {
    inner += text(W / 2, H / 2, 'No data for this period', { anchor: 'middle', fill: MUTED });
  } else if (data.length === 1) {
    inner += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${data[0].color}"/>`;
  } else {
    let a0 = -Math.PI / 2;
    data.forEach((s) => {
      const a1 = a0 + (s.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      inner += `<path d="M${cx} ${cy} L${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z" fill="${s.color}" stroke="#fff" stroke-width="2"/>`;
      const pct = Math.round((s.value / total) * 100);
      if (pct >= 6) {
        const mid = (a0 + a1) / 2;
        inner += text(cx + r * 0.62 * Math.cos(mid), cy + r * 0.62 * Math.sin(mid) + 4, `${pct}%`, { size: 12, anchor: 'middle', weight: 700, fill: s.light ? INK : '#fff' });
      }
      a0 = a1;
    });
  }
  data.forEach((s, i) => {
    const y = 120 + i * 30;
    inner += `<rect x="400" y="${y - 11}" width="14" height="14" fill="${s.color}"/>`;
    inner += text(424, y, s.label, { size: 13 });
    inner += text(640, y, s.value, { size: 13, anchor: 'end', weight: 700 });
  });
  return frame(title, inner);
}

function columnSvg(title, labels, values) {
  const max = niceMax(Math.max(0, ...values));
  const slot = (PLOT.r - PLOT.l) / Math.max(values.length, 1);
  const bw = Math.min(34, slot * 0.6);
  let inner = axes(max);
  values.forEach((v, i) => {
    const x = PLOT.l + i * slot + (slot - bw) / 2;
    const y = yOf(v, max);
    inner += `<rect x="${x}" y="${y}" width="${bw}" height="${PLOT.b - y}" rx="3" fill="${MINT}"/>`;
    if (v > 0) inner += text(x + bw / 2, y - 5, v, { size: 10, anchor: 'middle', weight: 700 });
    inner += text(x + bw / 2, PLOT.b + 18, labels[i], { size: 9, anchor: 'middle', fill: MUTED });
  });
  return frame(title, inner);
}

function lineSvg(title, labels, values) {
  const max = niceMax(Math.max(0, ...values));
  const slot = (PLOT.r - PLOT.l) / Math.max(values.length, 1);
  const pts = values.map((v, i) => [PLOT.l + i * slot + slot / 2, yOf(v, max)]);
  let inner = axes(max);
  inner += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ')}" fill="none" stroke="${GREEN}" stroke-width="3" stroke-linejoin="round"/>`;
  pts.forEach((p, i) => {
    inner += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#fff" stroke="${GREEN}" stroke-width="2"/>`;
    inner += text(p[0], PLOT.b + 18, labels[i], { size: 9, anchor: 'middle', fill: MUTED });
  });
  if (pts.length) {
    const last = pts[pts.length - 1];
    inner += text(last[0], last[1] - 10, values[values.length - 1], { size: 12, anchor: 'middle', weight: 700 });
  }
  return frame(title, inner);
}

function barPairSvg(title, items, days = 30, legend = [`Previous ${days} days`, `Last ${days} days`]) {
  const max = 100;
  const slot = (PLOT.r - PLOT.l) / items.length;
  const bw = 70;
  let inner = axes(max);
  items.forEach((it, i) => {
    const cx = PLOT.l + i * slot + slot / 2;
    const draw = (val, x, color) => {
      if (val == null) return text(x + bw / 2, PLOT.b - 8, 'n/a', { size: 11, anchor: 'middle', fill: MUTED });
      const y = yOf(val, max);
      return `<rect x="${x}" y="${y}" width="${bw}" height="${PLOT.b - y}" fill="${color}"/>` +
        text(x + bw / 2, y - 6, `${val}%`, { size: 12, anchor: 'middle', weight: 700 });
    };
    inner += draw(it.prior, cx - bw - 6, '#9AD9B5');
    inner += draw(it.recent, cx + 6, GREEN);
    inner += text(cx, PLOT.b + 22, it.label, { size: 12, anchor: 'middle' });
  });
  inner += `<rect x="${W - 250}" y="38" width="10" height="10" fill="#9AD9B5"/>${text(W - 235, 47, legend[0], { size: 10, fill: MUTED })}`;
  inner += `<rect x="${W - 130}" y="38" width="10" height="10" fill="${GREEN}"/>${text(W - 115, 47, legend[1], { size: 10, fill: MUTED })}`;
  return frame(title, inner);
}

// ── Brand: header logo + faded watermark on every sheet ─────────────────
const BRAND_DIR = path.join(__dirname, '..', 'assets', 'brand');
let BRAND = null;          // { header, watermark } PNG buffers, once loaded
let brandLoading = null;

/**
 * Loads (once) the header logo and a watermark — the emblem at ~9% opacity, so
 * cell text stays readable through it. Failure to load only skips branding.
 */
async function loadBrand() {
  if (BRAND) return BRAND;
  if (!brandLoading) {
    brandLoading = (async () => {
      const header = await sharp(path.join(BRAND_DIR, 'rs_text_logo.png')).resize({ width: 300 }).png().toBuffer();
      const watermark = await sharp(path.join(BRAND_DIR, 'RS_logo.png'))
        .resize({ width: 380 })
        .ensureAlpha()
        .composite([{ input: Buffer.from([255, 255, 255, 24]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
        .png()
        .toBuffer();
      BRAND = { header, watermark };
      return BRAND;
    })().catch((err) => { console.warn('Report branding unavailable:', err.message); BRAND = { header: null, watermark: null }; return BRAND; });
  }
  return brandLoading;
}

/** Logo top-right (header size 150x50) and a faded watermark in the middle of the sheet. */
function addBrand(wb, ws, { logoCol, wmCol, wmRow }) {
  if (!BRAND) return;
  if (BRAND.header) {
    const id = wb.addImage({ buffer: BRAND.header, extension: 'png' });
    ws.addImage(id, { tl: { col: logoCol, row: 0.1 }, ext: { width: 150, height: 50 } });
  }
  if (BRAND.watermark) {
    const id = wb.addImage({ buffer: BRAND.watermark, extension: 'png' });
    ws.addImage(id, { tl: { col: wmCol, row: wmRow }, ext: { width: 380, height: 389 }, editAs: 'absolute' });
  }
}

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

const shortWeek = (ymd) => {
  const [, m, d] = ymd.split('-').map(Number);
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${d}`;
};
const dateOnly = (v) => (v ? String(new Date(v).toISOString()).slice(0, 10) : '—');

function styleHeader(row, columns) {
  row.eachCell((c, col) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E6B3E' } };
    c.alignment = { vertical: 'middle', horizontal: columns?.[col - 1]?.align || 'left', wrapText: true };
  });
  row.height = 32;
}

const LINE = { style: 'thin', color: { argb: 'FFE4E9E6' } };

/**
 * A titled table sheet. Columns: { key, header, width, align?, numFmt? }.
 * Rows are 24pt tall and vertically centred (Khmer text needs the height),
 * lightly ruled and zebra-striped; the header row and first column stay put.
 */
function addTable(wb, name, title, subtitle, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }] });
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };   // prints one page wide
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { size: 16, bold: true, color: { argb: 'FF1E6B3E' } };
  ws.getRow(1).height = 30;
  ws.getCell('A1').alignment = { vertical: 'middle' };
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = { color: { argb: 'FF5B6B62' } };
  ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
  const header = ws.getRow(4);
  columns.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  styleHeader(header, columns);
  rows.forEach((r, i) => {
    const row = ws.addRow(columns.map(c => r[c.key]));
    row.height = 24;
    columns.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      cell.alignment = { vertical: 'middle', horizontal: c.align || 'left' };
      cell.border = { bottom: LINE };
      if (c.numFmt && typeof cell.value !== 'string') cell.numFmt = c.numFmt;
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAF9' } };
    });
  });
  if (rows.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: columns.length } };
  addBrand(wb, ws, { logoCol: Math.max(1, columns.length - 1.8), wmCol: Math.max(1, columns.length / 2 - 1.5), wmRow: 6 });
  return ws;
}

const REASON_LABEL = {
  declining: 'Score dropping', inactive: 'Inactive', slowing: 'Slowing down',
  stuck: 'Stuck', never_started: 'Never started',
};

async function buildDashboardWorkbook(data, scopeLabel) {
  const { kpis, signups_weekly, most_improved, at_risk_total, generated_at, window_days, _export } = data;
  const wa = window_days?.activity || 7;
  const wq = window_days?.quiz || 30;
  const { students, lastActive, trend, atRisk, enrolledSet, now } = _export;
  const subtitle = `${scopeLabel} · Generated ${new Date(generated_at).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

  await loadBrand();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Romduol Scholars';
  wb.created = now;

  // Summary
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  addTable(wb, 'Summary', 'Dashboard summary · Romduol Scholars', subtitle, [
    { key: 'metric', header: 'Metric', width: 34 },
    { key: 'value', header: 'Value', width: 14 },
    { key: 'note', header: 'Note', width: 44 },
  ], [
    { metric: 'Total students', value: kpis.total_students, note: `${kpis.new_students_7d} new in the last ${wa} days (${kpis.new_students_prev_7d} in the ${wa} days before)` },
    { metric: `Active students (${wa} days)`, value: kpis.active_students_7d, note: kpis.total_students ? `${Math.round((kpis.active_students_7d / kpis.total_students) * 100)}% of students` : '' },
    { metric: 'Paid / subscribed students', value: kpis.paid_students, note: '' },
    { metric: `Avg quiz score (last ${wq} days)`, value: kpis.avg_quiz_score_30d == null ? '—' : `${kpis.avg_quiz_score_30d}%`, note: kpis.avg_quiz_score_prev_30d == null ? '' : `${kpis.avg_quiz_score_prev_30d}% in the previous ${wq} days (${pct(kpis.avg_quiz_score_30d, kpis.avg_quiz_score_prev_30d)}% change)` },
    { metric: 'Students needing attention', value: at_risk_total, note: '' },
  ]);

  addTable(wb, 'Student growth', 'Student growth', subtitle, [
    { key: 'week', header: 'Week starting', width: 16 },
    { key: 'count', header: 'New sign-ups', width: 16 },
    { key: 'cumulative', header: 'Total students', width: 16 },
  ], signups_weekly);

  // Student performance (one row per student in scope)
  const riskById = new Map(atRisk.map(a => [a.student_id, a]));
  const statusOf = (s) => {
    if (s.is_active === false) return 'Deactivated';
    if (!enrolledSet.has(s.id)) return 'Not enrolled';
    const r = riskById.get(s.id);
    return r ? REASON_LABEL[r.reason] || 'Needs attention' : 'On track';
  };
  const perfRows = students.map((s) => {
    const t = trend.get(s.id);
    return {
      name: s.name || '—',
      joined: dateOnly(s.created_at),
      enrolled: enrolledSet.has(s.id) ? 'Yes' : 'No',
      last: dateOnly(lastActive.get(s.id)),
      avg: t?.ra != null ? Math.round(t.ra) : null,
      prev: t?.pa != null ? Math.round(t.pa) : null,
      delta: t?.delta != null ? Math.round(t.delta) : null,
      status: statusOf(s),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const perf = addTable(wb, 'Student performance', 'Student performance', subtitle, [
    { key: 'name', header: 'Student', width: 28 },
    { key: 'joined', header: 'Joined', width: 14 },
    { key: 'enrolled', header: 'Enrolled', width: 11 },
    { key: 'last', header: 'Last active', width: 14 },
    { key: 'avg', header: `Avg quiz (${wq}d) %`, width: 17 },
    { key: 'prev', header: `Avg quiz (prev ${wq}d) %`, width: 21 },
    { key: 'delta', header: 'Change (pts)', width: 14 },
    { key: 'status', header: 'Status', width: 18 },
  ], perfRows);
  const statusFill = { 'On track': 'FFD6F1E2', 'Deactivated': 'FFE6EAEE', 'Not enrolled': 'FFE6EAEE' };
  perf.eachRow((row, n) => {
    if (n < 5) return;
    const v = row.getCell(8).value;
    row.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusFill[v] || 'FFFBD5D2' } };
    const d = row.getCell(7).value;
    if (typeof d === 'number') row.getCell(7).font = { color: { argb: d >= 0 ? 'FF0B6B3A' : 'FFB42318' }, bold: true };
  });

  addTable(wb, 'Needs attention', `Needs attention (${at_risk_total} students)`, subtitle, [
    { key: 'name', header: 'Student', width: 28 },
    { key: 'reason', header: 'Reason', width: 18 },
    { key: 'last', header: 'Last active', width: 14 },
    { key: 'days', header: 'Days inactive', width: 15 },
    { key: 'avg', header: 'Avg quiz %', width: 13 },
    { key: 'delta', header: 'Change (pts)', width: 14 },
  ], atRisk.map(a => ({
    name: a.name || '—', reason: REASON_LABEL[a.reason] || a.reason, last: dateOnly(a.last_active),
    days: a.days_inactive, avg: a.recent_avg, delta: a.delta,
  })));

  addTable(wb, 'Most improved', `Most improved (last ${wq} days vs previous ${wq} days)`, subtitle, [
    { key: 'name', header: 'Student', width: 28 },
    { key: 'prior', header: 'Previous avg %', width: 16 },
    { key: 'recent', header: 'Recent avg %', width: 16 },
    { key: 'delta', header: 'Change (pts)', width: 14 },
    { key: 'quizzes', header: 'Quizzes', width: 10 },
  ], most_improved.map(m => ({ name: m.name || '—', prior: m.prior_avg, recent: m.recent_avg, delta: m.delta, quizzes: m.quizzes })));

  // Charts sheet (PNG pictures)
  const counts = new Map();
  perfRows.forEach(r => {
    const k = r.status === 'On track' ? 'On track' : (r.status === 'Deactivated' || r.status === 'Not enrolled') ? r.status : 'Needs attention';
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const slices = [
    { label: 'On track', value: counts.get('On track') || 0, color: GREEN },
    { label: 'Needs attention', value: counts.get('Needs attention') || 0, color: '#E5484D' },
    { label: 'Not enrolled', value: counts.get('Not enrolled') || 0, color: '#C5CDD6', light: true },
    { label: 'Deactivated', value: counts.get('Deactivated') || 0, color: '#8A94A6' },
  ];
  const labels = signups_weekly.map(w => shortWeek(w.week));
  const images = await Promise.all([
    png(pieSvg('Student status', slices)),
    png(columnSvg('New sign-ups per week', labels, signups_weekly.map(w => w.count))),
    png(lineSvg('Total students over time', labels, signups_weekly.map(w => w.cumulative))),
    png(barPairSvg('Average quiz score', [{
      label: 'All classes',
      prior: kpis.avg_quiz_score_prev_30d,
      recent: kpis.avg_quiz_score_30d,
    }], wq)),
  ]);
  const cs = wb.addWorksheet('Charts', { views: [{ showGridLines: false }] });
  cs.getCell('A1').value = 'Charts · Romduol Scholars';
  cs.getCell('A1').font = { size: 16, bold: true, color: { argb: 'FF1E6B3E' } };
  cs.getCell('A2').value = subtitle;
  cs.getCell('A2').font = { color: { argb: 'FF5B6B62' } };
  addBrand(wb, cs, { logoCol: 18, wmCol: 8, wmRow: 12 });
  const spots = [[0, 3], [11, 3], [0, 23], [11, 23]];
  images.forEach((buf, i) => {
    const id = wb.addImage({ buffer: buf, extension: 'png' });
    cs.addImage(id, { tl: { col: spots[i][0], row: spots[i][1] }, ext: { width: W, height: H } });
  });

  return wb;
}

const STATUS_LABEL = {
  on_track: 'On track', behind: 'Behind', inactive: 'Inactive', not_started: 'Not started', completed: 'Completed',
};
const STATUS_FILL = {
  on_track: 'FFD6F1E2', behind: 'FFFCEBB3', inactive: 'FFFBD5D2', not_started: 'FFE6EAEE', completed: 'FFDDDFFB',
};

/**
 * The dashboard's student table as a workbook. `groups` = [{ title, rows }]:
 * one sheet per group (for "all classes": "All classes" first, then a sheet
 * for each class).
 */
async function buildStudentTableWorkbook(groups, { includeContacts = false, description = '' } = {}) {
  await loadBrand();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Romduol Scholars';
  await addStudentSummarySheet(wb, groups, description);
  const columns = [
    { key: 'name', header: 'Student', width: 30 },
    ...(includeContacts ? [{ key: 'email', header: 'Email', width: 32 }, { key: 'phone', header: 'Phone', width: 18 }] : []),
    { key: 'course', header: 'Class', width: 28 },
    { key: 'lesson', header: 'Current lesson', width: 36 },
    { key: 'progress', header: 'Progress', width: 14, align: 'center', numFmt: '0"%"' },
    { key: 'avg', header: 'Avg quiz', width: 14, align: 'center', numFmt: '0"%"' },
    { key: 'quizzes', header: 'Quizzes taken', width: 17, align: 'center' },
    { key: 'last', header: 'Last active', width: 17, align: 'center', numFmt: 'yyyy-mm-dd' },
    { key: 'idle', header: 'Days inactive', width: 17, align: 'center', numFmt: '0' },
    { key: 'status', header: 'Status', width: 16, align: 'center' },
  ];
  const statusCol = columns.findIndex(c => c.key === 'status') + 1;
  const progressCol = columns.findIndex(c => c.key === 'progress') + 1;
  const used = new Set(['summary']);
  // Excel sheet names: max 31 chars, none of  [ ] : * ? / \, unique (case-insensitive).
  const sheetName = (title, i) => {
    let base = String(title || '').replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || `Class ${i}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  };

  groups.forEach((g, i) => {
    const name = sheetName(g.title, i);
    const ws = addTable(wb, name, `Student performance · ${g.title} · Romduol Scholars`,
      `${description || 'All classes'} · ${g.rows.length} rows · Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
      columns,
      g.rows.map(r => ({
        name: r.name || '—', email: r.email || '', phone: r.phone || '', course: r.course_title || '—',
        lesson: lessonLabel(r),
        progress: r.progress, avg: r.avg_quiz ?? '—', quizzes: `${r.quizzes_attempted}/${r.quizzes_total}`,
        last: r.last_active ? new Date(String(r.last_active).slice(0, 10) + 'T00:00:00Z') : '—',
        idle: r.days_inactive ?? '—', status: r.status,
      })));
    ws.eachRow((row, n) => {
      if (n < 5) return;
      const st = row.getCell(statusCol).value;
      row.getCell(statusCol).value = STATUS_LABEL[st] || st;
      row.getCell(statusCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[st] || 'FFE6EAEE' } };
      const pct = row.getCell(progressCol).value;
      if (typeof pct === 'number') {
        row.getCell(progressCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pct >= 60 ? 'FFB9E6CD' : pct >= 20 ? 'FFE3F6EC' : 'FFF6F8F7' } };
      }
    });
  });
  return wb;
}

function lessonLabel(r) {
  if (r.finished) return 'Finished';
  if (r.status === 'not_started') return 'Not started';
  if (r.current_lesson_index == null) return '—';
  return `Ch ${r.current_lesson_index} · ${r.current_lesson_title || ''}`.trim();
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * First sheet of the student workbook, laid out on a 12-column grid (B:M):
 * eight KPI tiles, a per-class comparison with totals, three charts and a short
 * guide. Chart pictures use "C1, C2…" labels (the class table maps each code to
 * its name) so they don't depend on Khmer fonts being installed on the server.
 */
async function addStudentSummarySheet(wb, groups, description) {
  const perClass = groups.length > 1 ? groups.slice(1) : groups;
  const all = groups[0].rows;
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  ws.getColumn(1).width = 3;
  for (let c = 2; c <= 13; c++) ws.getColumn(c).width = 13;
  ws.getColumn(14).width = 3;

  const GREEN_ARGB = 'FF1E6B3E';
  const TILE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F8F6' } };
  const BOX = { style: 'thin', color: { argb: 'FFD7E2DB' } };
  const box = (r1, c1, r2, c2) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      ws.getCell(r, c).border = {
        top: r === r1 ? BOX : undefined, bottom: r === r2 ? BOX : undefined,
        left: c === c1 ? BOX : undefined, right: c === c2 ? BOX : undefined,
      };
    }
  };
  const section = (row, text) => {
    const c = ws.getCell(row, 2);
    c.value = text;
    c.font = { size: 13, bold: true, color: { argb: GREEN_ARGB } };
    ws.getRow(row).height = 24;
    c.alignment = { vertical: 'middle' };
  };

  ws.getCell('B1').value = 'Student performance summary · Romduol Scholars';
  ws.getCell('B1').font = { size: 18, bold: true, color: { argb: GREEN_ARGB } };
  ws.getCell('B1').alignment = { vertical: 'middle' };
  ws.getRow(1).height = 34;
  ws.getCell('B2').value = `${description || 'All classes'} · Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  ws.getCell('B2').font = { color: { argb: 'FF5B6B62' } };

  // ── KPI tiles: 4 per row, 3 columns each ──
  const count = (st) => all.filter(r => r.status === st).length;
  const share = (n) => (all.length ? `${Math.round((n / all.length) * 100)}% of enrolments` : '—');
  const active7 = all.filter(r => r.days_inactive != null && r.days_inactive < 7).length;
  const progressAvg = round1(mean(all.map(r => r.progress)));
  const quizAvg = round1(mean(all.map(r => r.avg_quiz).filter(v => v != null)));
  const uniqueCount = new Set(all.map(r => r.student_id)).size;
  const tiles = [
    [
      { label: 'STUDENTS', value: uniqueCount, fmt: '0', note: `${all.length} enrolments` },
      { label: 'AVG PROGRESS', value: progressAvg ?? 0, fmt: '0.0"%"', note: 'lessons and units finished' },
      { label: 'AVG QUIZ SCORE', value: quizAvg ?? '—', fmt: '0.0"%"', note: 'best score per quiz, averaged' },
      { label: 'ACTIVE (7 DAYS)', value: active7, fmt: '0', note: share(active7) },
    ],
    [
      { label: 'INACTIVE (7+ DAYS)', value: count('inactive'), fmt: '0', note: share(count('inactive')), color: 'FFB42318' },
      { label: 'BEHIND', value: count('behind'), fmt: '0', note: share(count('behind')), color: 'FF92400E' },
      { label: 'NOT STARTED', value: count('not_started'), fmt: '0', note: share(count('not_started')) },
      { label: 'COMPLETED', value: count('completed'), fmt: '0', note: share(count('completed')), color: 'FF3730A3' },
    ],
  ];
  section(4, 'Key numbers');
  tiles.forEach((rowTiles, ti) => {
    const r0 = 5 + ti * 4;
    ws.getRow(r0).height = 20;
    ws.getRow(r0 + 1).height = 38;
    ws.getRow(r0 + 2).height = 20;
    rowTiles.forEach((t, i) => {
      const c0 = 2 + i * 3;
      [[r0, t.label, { size: 9, bold: true, color: { argb: 'FF5B6B62' } }],
       [r0 + 1, t.value, { size: 22, bold: true, color: { argb: t.color || 'FF0F1F17' } }],
       [r0 + 2, t.note, { size: 9, color: { argb: 'FF5B6B62' } }]].forEach(([r, v, font], k) => {
        ws.mergeCells(r, c0, r, c0 + 2);
        const cell = ws.getCell(r, c0);
        cell.value = v;
        cell.font = font;
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        if (k === 1 && t.fmt && typeof v === 'number') cell.numFmt = t.fmt;
      });
      for (let r = r0; r <= r0 + 2; r++) for (let c = c0; c <= c0 + 2; c++) ws.getCell(r, c).fill = TILE;
      box(r0, c0, r0 + 2, c0 + 2);
    });
    if (ti === 0) ws.getRow(r0 + 3).height = 8;
  });

  // ── By class ──
  let row = 14;
  section(row, 'By class');
  row += 1;
  const head = ['Code', 'Class', '', '', 'Students', 'Avg progress', 'Avg quiz', 'On track', 'Behind', 'Inactive', 'Not started', 'Completed'];
  head.forEach((h, i) => { ws.getCell(row, 2 + i).value = h; });
  ws.mergeCells(row, 3, row, 5);
  const headRow = ws.getRow(row);
  headRow.eachCell({ includeEmpty: false }, (c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_ARGB } };
  });
  for (let c = 2; c <= 13; c++) {
    ws.getCell(row, c).alignment = { vertical: 'middle', horizontal: c >= 6 || c === 2 ? 'center' : 'left', wrapText: true, indent: c === 3 ? 1 : 0 };
    ws.getCell(row, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_ARGB } };
  }
  headRow.height = 32;
  const firstClassRow = row + 1;
  perClass.forEach((g, i) => {
    const r = firstClassRow + i;
    const rows = g.rows;
    const vals = {
      2: `C${i + 1}`, 3: g.title, 6: rows.length,
      7: round1(mean(rows.map(x => x.progress))), 8: round1(mean(rows.map(x => x.avg_quiz).filter(v => v != null))) ?? '—',
    };
    ['on_track', 'behind', 'inactive', 'not_started', 'completed'].forEach((st, k) => { vals[9 + k] = rows.filter(x => x.status === st).length; });
    ws.mergeCells(r, 3, r, 5);
    Object.entries(vals).forEach(([c, v]) => { ws.getCell(r, Number(c)).value = v; });
    ws.getRow(r).height = 26;
    for (let c = 2; c <= 13; c++) {
      const cell = ws.getCell(r, c);
      cell.alignment = { vertical: 'middle', horizontal: c >= 6 || c === 2 ? 'center' : 'left', indent: c === 3 ? 1 : 0 };
      cell.border = { bottom: LINE };
      if (c === 7 || c === 8) cell.numFmt = '0.0"%"';
      if (c === 3) cell.font = { bold: true };
    }
  });
  let lastRow = firstClassRow + perClass.length - 1;
  if (perClass.length > 1) {
    const r = lastRow + 1;
    ws.mergeCells(r, 3, r, 5);
    ws.getCell(r, 3).value = 'All classes';
    ws.getCell(r, 6).value = { formula: `SUM(F${firstClassRow}:F${lastRow})`, result: perClass.reduce((a, g) => a + g.rows.length, 0) };
    ws.getCell(r, 7).value = progressAvg;
    ws.getCell(r, 8).value = quizAvg ?? '—';
    ['I', 'J', 'K', 'L', 'M'].forEach((col, k) => {
      const st = ['on_track', 'behind', 'inactive', 'not_started', 'completed'][k];
      ws.getCell(`${col}${r}`).value = { formula: `SUM(${col}${firstClassRow}:${col}${lastRow})`, result: count(st) };
    });
    ws.getRow(r).height = 26;
    for (let c = 2; c <= 13; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { bold: true };
      cell.fill = TILE;
      cell.alignment = { vertical: 'middle', horizontal: c >= 6 || c === 2 ? 'center' : 'left', indent: c === 3 ? 1 : 0 };
      cell.border = { top: { style: 'thin', color: { argb: GREEN_ARGB } }, bottom: { style: 'thin', color: { argb: GREEN_ARGB } } };
      if (c === 7 || c === 8) cell.numFmt = '0.0"%"';
    }
    lastRow = r;
  }

  // ── Charts: two per row, six columns (576px) each ──
  const CH_W = 520, CH_H = Math.round(520 * H / W);          // 520 x 267 — leaves slack inside 6 columns
  const slices = [
    { label: 'On track', value: count('on_track'), color: GREEN },
    { label: 'Behind', value: count('behind'), color: '#E0A100' },
    { label: 'Inactive', value: count('inactive'), color: '#E5484D' },
    { label: 'Not started', value: count('not_started'), color: '#C5CDD6', light: true },
    { label: 'Completed', value: count('completed'), color: '#5B5BD6' },
  ];
  const buckets = Array(10).fill(0);
  all.forEach(r => { if (r.avg_quiz != null) buckets[Math.min(9, Math.max(0, Math.floor(r.avg_quiz / 10)))] += 1; });
  const classAvg = (g, key) => { const m = mean(g.rows.map(r => r[key]).filter(v => v != null)); return m == null ? null : Math.round(m); };
  const images = await Promise.all([
    png(pieSvg('Student status (all enrolments)', slices)),
    png(barPairSvg('Average progress and quiz score by class', perClass.map((g, i) => ({ label: `C${i + 1}`, prior: classAvg(g, 'progress'), recent: classAvg(g, 'avg_quiz') })), 0, ['Avg progress', 'Avg quiz'])),
    png(columnSvg('Quiz scores: students per score band', ['0–10', '10–20', '20–30', '30–40', '40–50', '50–60', '60–70', '70–80', '80–90', '90–100'], buckets)),
  ]);
  const chartsRow = lastRow + 2;
  section(chartsRow, 'Charts');
  const rowsPerChart = Math.ceil(CH_H / 20) + 1;                  // default row = 20px
  const spots = [[1, chartsRow], [7, chartsRow], [1, chartsRow + rowsPerChart]];   // 0-indexed: col B/H, row after heading
  images.forEach((buf, i) => {
    const id = wb.addImage({ buffer: buf, extension: 'png' });
    ws.addImage(id, { tl: { col: spots[i][0], row: spots[i][1] }, ext: { width: CH_W, height: CH_H } });
  });

  // ── Guide: below the charts, label in B:C and text from D ──
  const gRow = chartsRow + rowsPerChart * 2 + 1;
  section(gRow, 'How to read this workbook');
  [
    ['On track', 'active in the last 7 days, not far behind the class'],
    ['Behind', 'progress 20+ points below the class median'],
    ['Inactive', 'no activity for 7 days or more'],
    ['Not started', 'no lesson progress, quiz or XP yet'],
    ['Completed', 'every lesson and unit finished'],
    ['Avg quiz', 'best score on each quiz taken, averaged'],
    ['Current lesson', 'the first chapter not yet finished'],
    ['Note', '"All classes" lists one row per enrolment, so a student in two classes appears twice'],
  ].forEach(([k, v], i) => {
    const r = gRow + 1 + i;
    ws.mergeCells(r, 2, r, 3);
    const kc = ws.getCell(r, 2);
    kc.value = k;
    kc.font = { bold: true, color: { argb: 'FF0F1F17' } };
    kc.alignment = { vertical: 'middle', indent: 1 };
    const vc = ws.getCell(r, 4);
    vc.value = v;
    vc.font = { color: { argb: 'FF35453C' } };
    vc.alignment = { vertical: 'middle' };
    ws.getRow(r).height = 20;
  });

  addBrand(wb, ws, { logoCol: 10.2, wmCol: 4, wmRow: 12 });
}

module.exports = { buildDashboardWorkbook, buildStudentTableWorkbook };
