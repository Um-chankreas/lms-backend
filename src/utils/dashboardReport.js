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
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Romduol Scholars';
  await addStudentSummarySheet(wb, groups, description);
  const columns = [
    { key: 'name', header: 'Student', width: 30 },
    ...(includeContacts ? [{ key: 'email', header: 'Email', width: 32 }, { key: 'phone', header: 'Phone', width: 18 }] : []),
    { key: 'course', header: 'Class', width: 28 },
    { key: 'lesson', header: 'Current lesson', width: 34 },
    { key: 'progress', header: 'Progress %', width: 16 },
    { key: 'avg', header: 'Avg quiz %', width: 16 },
    { key: 'quizzes', header: 'Quizzes taken', width: 18 },
    { key: 'last', header: 'Last active', width: 17 },
    { key: 'idle', header: 'Days inactive', width: 18 },
    { key: 'status', header: 'Status', width: 17 },
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
        progress: r.progress, avg: r.avg_quiz, quizzes: `${r.quizzes_attempted}/${r.quizzes_total}`,
        last: dateOnly(r.last_active), idle: r.days_inactive, status: r.status,
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
 * First sheet of the student workbook: key numbers, a per-class comparison with
 * totals, three charts (status split, progress vs quiz by class, quiz score
 * histogram) and a short guide to the columns and statuses. Chart pictures use
 * "C1, C2…" labels (the class table next to them maps each code to its name) so
 * they don't depend on Khmer fonts being installed on the server.
 */
async function addStudentSummarySheet(wb, groups, description) {
  const perClass = groups.length > 1 ? groups.slice(1) : groups;
  const all = groups.length > 1 ? groups[0].rows : groups[0].rows;
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 6 }, { width: 34 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }];

  const title = ws.getCell('A1');
  title.value = 'Student performance summary · Romduol Scholars';
  title.font = { size: 17, bold: true, color: { argb: 'FF1E6B3E' } };
  ws.getCell('A2').value = `${description || 'All classes'} · Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  ws.getCell('A2').font = { color: { argb: 'FF5B6B62' } };

  const section = (row, text) => {
    const c = ws.getCell(`A${row}`);
    c.value = text;
    c.font = { size: 13, bold: true, color: { argb: 'FF1E6B3E' } };
  };

  // Key numbers
  const uniqueIds = new Set(all.map(r => r.student_id));
  const count = (st) => all.filter(r => r.status === st).length;
  const share = (n) => (all.length ? `${Math.round((n / all.length) * 100)}% of enrolments` : '');
  const quizAvg = mean(all.map(r => r.avg_quiz).filter(v => v != null));
  section(4, 'Key numbers');
  const keys = [
    ['Students (unique)', uniqueIds.size, 'A student in two classes counts once here'],
    ['Enrolments (student × class)', all.length, 'The student sheets list one row per enrolment'],
    ['Average progress', `${round1(mean(all.map(r => r.progress))) ?? 0}%`, 'Share of lessons and units finished'],
    ['Average quiz score', quizAvg == null ? '—' : `${round1(quizAvg)}%`, 'Best score per quiz, averaged'],
    ['Active in the last 7 days', all.filter(r => r.days_inactive != null && r.days_inactive < 7).length, share(all.filter(r => r.days_inactive != null && r.days_inactive < 7).length)],
    ['Inactive (7+ days)', count('inactive'), share(count('inactive'))],
    ['Not started', count('not_started'), share(count('not_started'))],
    ['Completed the course', count('completed'), share(count('completed'))],
  ];
  keys.forEach(([label, value, note], i) => {
    const r = 5 + i;
    ws.getCell(`B${r}`).value = label;
    ws.getCell(`C${r}`).value = value;
    ws.getCell(`C${r}`).font = { bold: true };
    ws.getCell(`C${r}`).alignment = { horizontal: 'right' };
    ws.getCell(`D${r}`).value = note;
    ws.getCell(`D${r}`).font = { color: { argb: 'FF5B6B62' } };
    if (i % 2 === 0) for (const col of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) ws.getCell(`${col}${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8F7' } };
  });

  // By class
  let row = 5 + keys.length + 2;
  section(row, 'By class');
  row += 1;
  const head = ['Code', 'Class', 'Students', 'Avg progress %', 'Avg quiz %', 'On track', 'Behind', 'Inactive', 'Not started', 'Completed'];
  head.forEach((h, i) => { ws.getRow(row).getCell(i + 1).value = h; });
  styleHeader(ws.getRow(row));
  ws.getRow(row).alignment = { vertical: 'middle', wrapText: true };
  const firstClassRow = row + 1;
  perClass.forEach((g, i) => {
    const rows = g.rows;
    const vals = [
      `C${i + 1}`, g.title, rows.length,
      round1(mean(rows.map(r => r.progress))), round1(mean(rows.map(r => r.avg_quiz).filter(v => v != null))),
      ...['on_track', 'behind', 'inactive', 'not_started', 'completed'].map(st => rows.filter(r => r.status === st).length),
    ];
    const r = ws.getRow(firstClassRow + i);
    vals.forEach((v, c) => { r.getCell(c + 1).value = v; });
    r.getCell(2).font = { bold: true };
  });
  const lastClassRow = firstClassRow + perClass.length - 1;
  if (perClass.length > 1) {
    const t = ws.getRow(lastClassRow + 1);
    t.getCell(2).value = 'All classes';
    t.getCell(3).value = { formula: `SUM(C${firstClassRow}:C${lastClassRow})`, result: perClass.reduce((a, g) => a + g.rows.length, 0) };
    t.getCell(4).value = round1(mean(all.map(r => r.progress)));
    t.getCell(5).value = round1(quizAvg);
    ['F', 'G', 'H', 'I', 'J'].forEach((col, i) => {
      const st = ['on_track', 'behind', 'inactive', 'not_started', 'completed'][i];
      t.getCell(col).value = { formula: `SUM(${col}${firstClassRow}:${col}${lastClassRow})`, result: all.filter(r => r.status === st).length };
    });
    t.eachCell(c => { c.font = { bold: true }; c.border = { top: { style: 'thin', color: { argb: 'FF1E6B3E' } } }; });
    row = lastClassRow + 1;
  } else {
    row = lastClassRow;
  }

  // Charts
  const slices = [
    { label: 'On track', value: count('on_track'), color: GREEN },
    { label: 'Behind', value: count('behind'), color: '#E0A100' },
    { label: 'Inactive', value: count('inactive'), color: '#E5484D' },
    { label: 'Not started', value: count('not_started'), color: '#C5CDD6', light: true },
    { label: 'Completed', value: count('completed'), color: '#5B5BD6' },
  ];
  const buckets = Array(10).fill(0);
  all.forEach(r => { if (r.avg_quiz != null) buckets[Math.min(9, Math.max(0, Math.floor(r.avg_quiz / 10)))] += 1; });
  const images = await Promise.all([
    png(pieSvg('Student status (enrolments)', slices)),
    png(barPairSvg('Average progress and quiz score by class', perClass.map((g, i) => ({
      label: `C${i + 1}`,
      prior: round1(mean(g.rows.map(r => r.progress))) == null ? null : Math.round(mean(g.rows.map(r => r.progress))),
      recent: (() => { const q = mean(g.rows.map(r => r.avg_quiz).filter(v => v != null)); return q == null ? null : Math.round(q); })(),
    })), 0, ['Avg progress', 'Avg quiz'])),
    png(columnSvg('How quiz scores are spread (students per score band)', ['0–10', '10–20', '20–30', '30–40', '40–50', '50–60', '60–70', '70–80', '80–90', '90–100'], buckets)),
  ]);
  row += 2;
  section(row, 'Charts');
  const top = row; // images are 0-indexed rows: place just under the heading
  const spots = [[0, top + 1], [7, top + 1], [0, top + 20]];
  images.forEach((buf, i) => {
    const id = wb.addImage({ buffer: buf, extension: 'png' });
    ws.addImage(id, { tl: { col: spots[i][0], row: spots[i][1] }, ext: { width: W, height: H } });
  });

  // Guide (below the charts)
  let g = top + 41;
  section(g, 'How to read this workbook');
  const notes = [
    'On track — active in the last 7 days and not far behind the class.',
    'Behind — progress is 20+ points below the class median.',
    'Inactive — no activity for 7 days or more (or never active after starting).',
    'Not started — no lesson progress, quiz or XP yet.   Completed — every lesson and unit finished.',
    'Avg quiz % — the best score on each quiz the student took, averaged.   Current lesson — the first chapter not yet finished.',
    'The "All classes" sheet has one row per enrolment, so a student in two classes appears twice. Use the class sheets for per-class lists.',
  ];
  notes.forEach((n, i) => { ws.getCell(`B${g + 1 + i}`).value = n; ws.getCell(`B${g + 1 + i}`).font = { color: { argb: 'FF35453C' } }; });
}

module.exports = { buildDashboardWorkbook, buildStudentTableWorkbook };
