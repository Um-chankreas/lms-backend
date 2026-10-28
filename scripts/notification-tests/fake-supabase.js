// Minimal in-memory stand-in for the supabase client used by the notification code.
const Module = require('module');
const tables = {};
let idSeq = 1;
const isDateLike = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$| )/.test(v);
const toKey = (v) => (v instanceof Date ? v.getTime() : isDateLike(v) ? Date.parse(v.length <= 10 ? v + 'T00:00:00Z' : (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z')) : v);
const cmp = (a, b) => { const x = toKey(a), y = toKey(b); return x < y ? -1 : x > y ? 1 : 0; };

class Q {
  constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.payload = null; this.orders = []; this.lim = null; this.rng = null; this.one = null; this.opts = {}; }
  select() { this.selected = true; return this; }
  insert(rows) { this.op = 'insert'; this.payload = [].concat(rows); return this; }
  update(f) { this.op = 'update'; this.payload = f; return this; }
  upsert(row, opts) { this.op = 'upsert'; this.payload = [].concat(row); this.opts = opts || {}; return this; }
  eq(k, v) { this.filters.push(r => r[k] === v); return this; }
  neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
  in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
  not(k, op, v) { if (op === 'is') this.filters.push(r => (v === null ? r[k] != null : r[k] !== v)); return this; }
  is(k, v) { this.filters.push(r => (v === null ? r[k] == null : r[k] === v)); return this; }
  gte(k, v) { this.filters.push(r => r[k] != null && cmp(r[k], v) >= 0); return this; }
  gt(k, v) { this.filters.push(r => r[k] != null && cmp(r[k], v) > 0); return this; }
  lte(k, v) { this.filters.push(r => r[k] != null && cmp(r[k], v) <= 0); return this; }
  lt(k, v) { this.filters.push(r => r[k] != null && cmp(r[k], v) < 0); return this; }
  order(k, o) { this.orders.push([k, !(o && o.ascending === false)]); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  _run() {
    const rows = (tables[this.table] = tables[this.table] || []);
    if (this.op === 'insert') { this.payload.forEach(r => rows.push({ ...r })); return { data: null, error: null }; }
    if (this.op === 'upsert') {
      this.payload.forEach(r => { const key = this.opts.onConflict; const i = key ? rows.findIndex(x => x[key] === r[key]) : -1; if (i >= 0) Object.assign(rows[i], r); else rows.push({ ...r }); });
      return { data: null, error: null };
    }
    let out = rows.filter(r => this.filters.every(f => f(r)));
    if (this.op === 'update') { out.forEach(r => Object.assign(r, this.payload)); return { data: this.selected ? out.map(r => ({ ...r })) : null, error: null }; }
    this.orders.forEach(([k, asc]) => out.sort((a, b) => (asc ? 1 : -1) * cmp(a[k], b[k])));
    if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim != null) out = out.slice(0, this.lim);
    out = out.map(r => ({ ...r }));
    if (this.one) return { data: out[0] || null, error: null };
    return { data: out, error: null };
  }
  then(res, rej) { return Promise.resolve(this._run()).then(res, rej); }
}
const fake = { from: (t) => new Q(t) };
const orig = Module._load;
module.exports = {
  tables,
  install(extra = {}) {
    Module._load = function (r, ...a) {
      if (r.endsWith('config/supabase')) return fake;
      const key = Object.keys(extra).find(k => r.endsWith(k));
      if (key) return extra[key](orig.call(this, r, ...a));
      return orig.call(this, r, ...a);
    };
  },
  add(table, row) { (tables[table] = tables[table] || []).push({ id: row.id || 'id' + idSeq++, ...row }); },
  reset() { Object.keys(tables).forEach(k => delete tables[k]); },
};
