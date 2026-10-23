const ExcelJS = require('exceljs');
const sharp = require('sharp');

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

function barPairSvg(title, items, days = 30) {
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
  inner += `<rect x="${W - 250}" y="38" width="10" height="10" fill="#9AD9B5"/>${text(W - 235, 47, `Previous ${days} days`, { size: 10, fill: MUTED })}`;
  inner += `<rect x="${W - 130}" y="38" width="10" height="10" fill="${GREEN}"/>${text(W - 115, 47, `Last ${days} days`, { size: 10, fill: MUTED })}`;
  return frame(title, inner);
}

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

const shortWeek = (ymd) => {
  const [, m, d] = ymd.split('-').map(Number);
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${d}`;
};
const dateOnly = (v) => (v ? String(new Date(v).toISOString()).slice(0, 10) : '—');

function styleHeader(row) {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E6B3E' } };
    c.alignment = { vertical: 'middle' };
  });
  row.height = 22;
}

function addTable(wb, name, title, subtitle, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { size: 16, bold: true, color: { argb: 'FF1E6B3E' } };
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = { color: { argb: 'FF5B6B62' } };
  ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
  const header = ws.getRow(4);
  columns.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  styleHeader(header);
  rows.forEach(r => ws.addRow(columns.map(c => r[c.key])));
  if (rows.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: columns.length } };
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
  const spots = [[0, 3], [11, 3], [0, 23], [11, 23]];
  images.forEach((buf, i) => {
    const id = wb.addImage({ buffer: buf, extension: 'png' });
    cs.addImage(id, { tl: { col: spots[i][0], row: spots[i][1] }, ext: { width: W, height: H } });
  });

  return wb;
}

module.exports = { buildDashboardWorkbook };
