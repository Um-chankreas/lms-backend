const crypto = require('crypto');

/**
 * Read-only access to the storage project that holds the national textbooks.
 *
 * The scanned MoEYS PDFs live in a *different* Supabase project from the one
 * this server's database and `course-materials` bucket are in, so they can't
 * go through `config/supabase.js` — repointing that client would take the
 * database with it. This talks to the other project over its S3-compatible
 * endpoint instead, which is what the credentials we have are for.
 *
 * Only the listing needs credentials. The bucket itself is public, so the
 * PDFs are handed to the app as plain public URLs and never proxied.
 *
 * Signing is done here with node's crypto rather than pulling in the AWS SDK:
 * one GET, one signature, no dependency.
 *
 * Configure in .env (see .env.example):
 *   TEXTBOOK_SUPABASE_URL   https://<ref>.supabase.co
 *   TEXTBOOK_S3_ENDPOINT    https://<ref>.storage.supabase.co/storage/v1/s3
 *   TEXTBOOK_S3_REGION      us-east-1
 *   TEXTBOOK_S3_ACCESS_KEY / TEXTBOOK_S3_SECRET_KEY
 *
 * Leave them unset and every call returns an empty list, so a dev machine
 * without the keys serves an empty shelf instead of failing.
 */

const SERVICE = 's3';
// The textbook project is a different host from everything else this server
// talks to, so it can go unreachable on its own. `fetch` has no timeout of
// its own: without this, one unreachable listing leaves the request hanging
// and the Library tab spinning rather than showing an empty shelf.
const LIST_TIMEOUT_MS = 10000;
// Uploads carry a whole scanned PDF, so they get far longer than a listing.
const PUT_TIMEOUT_MS = 120000;
const ALGORITHM = 'AWS4-HMAC-SHA256';
const EMPTY_PAYLOAD = crypto.createHash('sha256').update('').digest('hex');

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

const config = () => ({
  projectUrl: (process.env.TEXTBOOK_SUPABASE_URL || '').replace(/\/+$/, ''),
  endpoint: (process.env.TEXTBOOK_S3_ENDPOINT || '').replace(/\/+$/, ''),
  region: process.env.TEXTBOOK_S3_REGION || 'us-east-1',
  accessKey: process.env.TEXTBOOK_S3_ACCESS_KEY || '',
  secretKey: process.env.TEXTBOOK_S3_SECRET_KEY || '',
});

const isConfigured = () => {
  const { projectUrl, endpoint, accessKey, secretKey } = config();
  return !!(projectUrl && endpoint && accessKey && secretKey);
};

/** Public URL of an object in a public bucket of the textbook project. */
const publicUrl = (bucket, name) => {
  const { projectUrl } = config();
  if (!projectUrl) return null;
  return `${projectUrl}/storage/v1/object/public/${bucket}/${encodeURIComponent(name)}`;
};

// RFC 3986 — encodeURIComponent leaves these alone but SigV4 wants them
// escaped, and a mismatch here is an opaque SignatureDoesNotMatch.
const rfc3986 = (value) => encodeURIComponent(value)
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A presigned GET URL for an object in a *private* bucket, valid for
 * `expiresIn` seconds.
 *
 * The public buckets hand their files over as plain URLs, but a private one
 * has no public path at all — Supabase answers its public endpoint with
 * NoSuchBucket. Signing the URL here means the app still fetches the PDF
 * straight from storage: the bytes never pass through this server, which for
 * a 21 MB formula sheet is the whole point.
 *
 * `expiresIn` is advisory. Measured against this endpoint, Supabase does NOT
 * honour X-Amz-Expires: a URL signed for 60 seconds still served 12 hours
 * later, while one signed 18+ hours earlier was refused. The signature itself
 * is checked — tampering with it gives 403 — so what this really buys is a
 * link scoped to one object, valid for a window the storage picks (~12-18h
 * from the signing time), not one we choose.
 *
 * So treat the returned URL as a bearer token for that object for most of a
 * day, and do NOT rely on a short expiry as an access control. If these files
 * ever need real gating, the route serving them has to require a session.
 */
function presignedUrl(bucket, name, expiresIn = 6 * 60 * 60) {
  const { endpoint, region, accessKey, secretKey } = config();
  if (!endpoint || !accessKey || !secretKey) return null;

  const url = new URL(endpoint);
  const canonicalUri = `${url.pathname}/${rfc3986(bucket)}/${rfc3986(name)}`;

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${SERVICE}/aws4_request`;

  // Must be sorted by name, and encoded exactly as it will appear in the URL.
  const query = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    query,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${secretKey}`, date);
  key = hmac(key, region);
  key = hmac(key, SERVICE);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  return `${url.origin}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

/**
 * One signed request against the S3 endpoint; returns the raw response body.
 * `body` is a Buffer for a PUT, omitted for a GET.
 */
async function signedRequest(method, pathname, query, body, contentType) {
  const { endpoint, region, accessKey, secretKey } = config();
  const url = new URL(endpoint + pathname);
  const host = url.host;
  // The endpoint carries its own path prefix (/storage/v1/s3), which is part
  // of what gets signed.
  const canonicalUri = url.pathname;

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${SERVICE}/aws4_request`;

  const payloadHash = body ? crypto.createHash('sha256').update(body).digest('hex') : EMPTY_PAYLOAD;

  const canonicalRequest = [
    method,
    canonicalUri,
    query,
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    'host;x-amz-content-sha256;x-amz-date',
    payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${secretKey}`, date);
  key = hmac(key, region);
  key = hmac(key, SERVICE);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  const controller = new AbortController();
  const timeoutMs = body ? PUT_TIMEOUT_MS : LIST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${url.origin}${canonicalUri}${query ? `?${query}` : ''}`, {
      method,
      body,
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        Authorization: `${ALGORITHM} Credential=${accessKey}/${scope}, `
          + 'SignedHeaders=host;x-amz-content-sha256;x-amz-date, '
          + `Signature=${signature}`,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
      },
      signal: controller.signal,
    });
  } catch (e) {
    const error = new Error(
      e.name === 'AbortError'
        ? `textbook storage did not respond within ${timeoutMs}ms`
        : `textbook storage unreachable: ${e.message}`,
    );
    error.code = 'TEXTBOOK_STORAGE_UNREACHABLE';
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || res.status;
    const error = new Error(`textbook storage ${method === 'GET' ? 'list' : 'write'} failed (${code})`);
    error.code = String(code);
    throw error;
  }
  return text;
}

// S3 XML escapes these in <Key>; filenames are ASCII today but a renamed
// upload with an ampersand shouldn't silently break the shelf.
const unescapeXml = (value) => value
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/**
 * Every object in `bucket`, following continuation tokens past the
 * 1000-key page limit. Returns `[{ name, size }]`, or `[]` when the
 * credentials aren't configured.
 */
async function listBucket(bucket) {
  if (!isConfigured()) return [];

  const out = [];
  let token = null;

  do {
    const query = [
      'list-type=2',
      'max-keys=1000',
      token ? `continuation-token=${encodeURIComponent(token)}` : null,
    ].filter(Boolean).join('&');

    const xml = await signedRequest('GET', `/${bucket}`, query);

    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const entry = match[1];
      const key = (entry.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
      if (!key) continue;
      const size = (entry.match(/<Size>(\d+)<\/Size>/) || [])[1];
      out.push({ name: unescapeXml(key), size: size ? parseInt(size, 10) : null });
    }

    const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    token = next ? unescapeXml(next[1]) : null;
  } while (token);

  return out;
}

/**
 * Upload one object. Overwrites silently (that's S3), so callers that care
 * about collisions check listBucket first. Returns its public URL.
 */
async function putObject(bucket, name, buffer, contentType) {
  await signedRequest('PUT', `/${bucket}/${encodeURIComponent(name)}`, '', buffer, contentType);
  return publicUrl(bucket, name);
}

/** Remove one object. Deleting a missing key is a no-op in S3. */
async function deleteObject(bucket, name) {
  await signedRequest('DELETE', `/${bucket}/${encodeURIComponent(name)}`, '');
}

/** Download a public object's bytes (used to move a file to a new name). */
async function getPublicObject(bucket, name) {
  const res = await fetch(publicUrl(bucket, name));
  if (!res.ok) throw new Error(`could not read ${name} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download an object's bytes from a *private* bucket, via a presigned URL
 * (the public path doesn't exist for those). Used to move a formula sheet.
 */
async function getObject(bucket, name) {
  const url = presignedUrl(bucket, name, 300);
  if (!url) throw new Error('textbook storage is not configured');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not read ${name} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** name -> size for every cover image (<stem>.jpg) in a listing. */
const coverIndex = (entries) =>
  new Map(entries.filter(e => /\.jpg$/i.test(e.name)).map(e => [e.name, e.size]));

/**
 * Public URL of a book's cover, or null when it has none. The size is
 * appended so replacing a cover (same filename) busts browser/app caches.
 */
const coverUrl = (bucket, stem, covers) => {
  const name = `${stem}.jpg`;
  if (!covers || !covers.has(name)) return null;
  return `${publicUrl(bucket, name)}?v=${covers.get(name) ?? 0}`;
};

module.exports = {
  isConfigured, listBucket, publicUrl, putObject, deleteObject, getPublicObject, getObject,
  coverIndex, coverUrl, presignedUrl,
};
