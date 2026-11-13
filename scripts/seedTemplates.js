// Seeds message_templates and message_reasons from seed/follow-up-templates.json.
//   node scripts/seedTemplates.js            insert what is missing, never touch an existing row
//   node scripts/seedTemplates.js --refresh  also update rows nobody edited (edited = false)
require('../src/config/loadEnv');
const supabase = require('../src/config/supabase');
const seed = require('../seed/follow-up-templates.json');

const templateRows = () => seed.templates.flatMap(t => ['km', 'en'].map(lang => ({
  key: t.key, lang, audience: t.audience, case_code: t.case_code, body: t.body[lang],
  buttons: t.buttons || [],
  extra: { ...(t.variant_if_attended_zero ? { variant_if_attended_zero: t.variant_if_attended_zero } : {}), ...(t.steps ? { steps: t.steps } : {}) },
  asks_reason: !!t.asks_reason, copy_only: !!t.copy_only,
})));
const reasonRows = () => [
  ...seed.reasons.map(r => ({ reason: r.reason, label_km: r.button.km, label_en: r.button.en, reply_km: r.reply.km, reply_en: r.reply.en, reply_links: r.reply_links || [] })),
  ...Object.entries(seed.callback_replies).map(([k, v]) => ({ reason: k, label_km: null, label_en: null, reply_km: v.km, reply_en: v.en, reply_links: [] })),
];

async function run({ refresh = false } = {}) {
  const t = templateRows();
  const r = reasonRows();
  let res = await supabase.from('message_templates').upsert(t, { onConflict: 'key,lang', ignoreDuplicates: true });
  if (res.error) throw res.error;
  res = await supabase.from('message_reasons').upsert(r, { onConflict: 'reason', ignoreDuplicates: true });
  if (res.error) throw res.error;
  if (refresh) {
    for (const row of t) await supabase.from('message_templates').update(row).eq('key', row.key).eq('lang', row.lang).eq('edited', false);
    for (const row of r) await supabase.from('message_reasons').update(row).eq('reason', row.reason).eq('edited', false);
  }
  const { count: tc } = await supabase.from('message_templates').select('*', { count: 'exact', head: true });
  const { count: rc } = await supabase.from('message_reasons').select('*', { count: 'exact', head: true });
  return { templates: tc, reasons: rc };
}

module.exports = { run, templateRows, reasonRows };
if (require.main === module) {
  run({ refresh: process.argv.includes('--refresh') })
    .then(c => { console.log(`Seeded. message_templates: ${c.templates} rows, message_reasons: ${c.reasons} rows.`); process.exit(0); })
    .catch(e => { console.error('Seed failed:', e.message || e); process.exit(1); });
}
