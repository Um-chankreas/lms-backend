// Phone-number handling.
//
// Users can type a local number (e.g. "092 123 456" or "92123456") OR a full
// international number ("+85592123456"). Everything is normalized to one
// canonical E.164 form so signup and login always match on the same string.
//
// A number without a "+" is assumed to belong to DEFAULT_COUNTRY_CODE
// (Cambodia, +855, override with env PHONE_DEFAULT_COUNTRY_CODE): the leading
// trunk "0" is dropped and the country code is prepended.
//   "092 123 456"   -> "+85592123456"
//   "92123456"      -> "+85592123456"
//   "+85592123456"  -> "+85592123456"
// A number typed with "+" is kept as-is, so other countries still work.

const DEFAULT_COUNTRY_CODE = (process.env.PHONE_DEFAULT_COUNTRY_CODE || '+855').replace(/[^\d+]/g, '');

function normalizePhone(input) {
  let p = String(input == null ? '' : input).trim().replace(/[\s\-().]/g, '');
  if (!p) return '';

  if (p.startsWith('00')) p = '+' + p.slice(2);        // 00 international prefix
  if (p.startsWith('+')) return p;                     // already international

  p = p.replace(/^0+/, '');                            // drop national trunk zero(s)
  return DEFAULT_COUNTRY_CODE + p;
}

// E.164: "+", a non-zero leading digit, total 8–15 digits.
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

function isValidPhone(input) {
  return E164_REGEX.test(normalizePhone(input));
}

module.exports = { normalizePhone, isValidPhone, E164_REGEX, DEFAULT_COUNTRY_CODE };
