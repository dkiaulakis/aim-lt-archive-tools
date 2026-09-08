'use strict';

/**
 * The ONE client for the AI Mastermind LT public archive API.
 *
 * Both the MCP server and the CLI go through this file, and this file goes through the site's
 * public JSON API, which goes through the same approval boundary the HTML pages use. That is
 * the whole chain: there is exactly one place that knows how to reach the archive and exactly
 * one place that decides what may leave it. Nothing here filters, re-ranks or re-implements policy - if a message is
 * not in the API's answer it is because the approval boundary withheld it, not because a
 * client chose to.
 *
 * The API serves only the four publicly granted surfaces (list, detail, search, media). There
 * is deliberately no method here for a bulk export: the surface does not exist server-side,
 * and adding a client-side paging loop that walks the whole archive would be the same thing
 * by another name. A caller who wants the next page asks for the next page.
 */

const DEFAULT_BASE_URL = 'https://grupe.aimastermind.lt';
const API_PATH = '/bendra/api.php';
const API_VERSION = 'v1';
// The server caps one attachment at 1 MiB. This is the client's own bound, because a client
// that trusts the server to limit the response has no limit at all - a redirect, a proxy or a
// future misconfiguration would stream straight into memory.
const MEDIA_MAX_BYTES = 1048576;
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT = 'aim-lt-archive-client/1.0 (+https://grupe.aimastermind.lt/llms.txt)';

class ArchiveApiError extends Error {
  constructor(status, code, message, url) {
    super(`${code}: ${message}`);
    this.name = 'ArchiveApiError';
    this.status = status;
    this.code = code;
    this.detail = message;
    this.url = url;
  }
}

/** Drop what the caller did not actually set, so a blank never reaches the server as a value.
 *  api.php refuses an unknown parameter and validates every known one, so sending `q=` would
 *  turn "no filter" into a refusal. Everything else is passed through unchanged and untrusted
 *  - the server is the validator, not this file. */
function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

function createArchiveClient(options = {}) {
  const baseUrl = String(options.baseUrl || process.env.AIM_LT_ARCHIVE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl || globalThis.fetch;

  // PATH_INFO addressing (/archive/api.php/v1/messages) is what the live host serves and what
  // /llms.txt publishes. `query` addressing (?resource=messages) reaches the SAME router in
  // api.php and exists for a host that does not pass PATH_INFO to the script; it is an option
  // rather than an automatic fallback because a silent retry would hide a broken deployment.
  const style = options.pathStyle === 'query' ? 'query' : 'path';

  function urlFor(resource, params) {
    const search = new URLSearchParams(cleanParams(params));
    if (style === 'query') {
      if (resource) search.set('resource', resource);
      const query = search.toString();
      return `${baseUrl}${API_PATH}${query ? '?' + query : ''}`;
    }
    const query = search.toString();
    return `${baseUrl}${API_PATH}/${API_VERSION}/${resource}${query ? '?' + query : ''}`;
  }

  async function request(resource, params) {
    const url = urlFor(resource, params);
    const response = await doFetch(url, {
      headers: {Accept: 'application/json', 'User-Agent': USER_AGENT},
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { payload = null; }
    if (!response.ok || (payload && payload.error)) {
      const code = (payload && payload.error) || `http_${response.status}`;
      const detail = (payload && payload.message) || text.slice(0, 200) || 'no body';
      throw new ArchiveApiError(response.status, code, detail, url);
    }
    if (payload === null) throw new ArchiveApiError(response.status, 'invalid_json', 'response was not JSON', url);
    return payload;
  }

  /** Attachment bytes. Streamed with a hard ceiling, so an oversized body is abandoned
   *  mid-flight rather than buffered and then rejected. */
  async function media(mediaId) {
    const url = urlFor('media', {media: mediaId});
    const response = await doFetch(url, {
      headers: {'User-Agent': USER_AGENT}, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (!response.ok) {
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch (_) { payload = null; }
      throw new ArchiveApiError(response.status, (payload && payload.error) || `http_${response.status}`,
        (payload && payload.message) || text.slice(0, 200), url);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) {
      throw new ArchiveApiError(200, 'media_too_large', `declared ${declared} bytes exceeds the ${MEDIA_MAX_BYTES} byte client cap`, url);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MEDIA_MAX_BYTES) {
        throw new ArchiveApiError(200, 'media_too_large', `body exceeded the ${MEDIA_MAX_BYTES} byte client cap`, url);
      }
      chunks.push(Buffer.from(chunk));
    }
    return {contentType, bytes: total, body: Buffer.concat(chunks), url};
  }

  /** The daily digests. These are the site's OWN published JSON files, not an API surface -
   *  they carry counts and topic labels, never message text, and they are the summarized view
   *  llms.txt asks a machine to prefer over walking the archive page by page. */
  async function fetchStatic(pathname) {
    const url = `${baseUrl}${pathname}`;
    const response = await doFetch(url, {
      headers: {Accept: 'application/json', 'User-Agent': USER_AGENT}, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new ArchiveApiError(response.status, `http_${response.status}`, text.slice(0, 200), url);
    try { return JSON.parse(text); } catch (_) {
      throw new ArchiveApiError(response.status, 'invalid_json', 'response was not JSON', url);
    }
  }

  /** Turn an address the INDEX published into a path we are willing to fetch.
   *
   *  The index is our own site, but "our own site" is a belief about a response body, not a
   *  fact about it. A client that fetches whatever URL a JSON reply hands it is the shape of
   *  an SSRF, and it stays that shape whether or not today's reply is honest. So the only
   *  thing that gets followed is an address that resolves back to the SAME ORIGIN we asked.
   *  That refuses an absolute `https://elsewhere/`, a protocol-relative `//elsewhere/`, and
   *  anything else that would take the fetch off this host. */
  function resolveStatic(published, context) {
    if (typeof published !== 'string' || published === '') {
      throw new ArchiveApiError(200, 'edition_url_missing',
        `the digest index published no address for ${context}`, `${baseUrl}/apzvalgos/index.json`);
    }
    let resolved;
    try { resolved = new URL(published, baseUrl); } catch (_) {
      throw new ArchiveApiError(200, 'edition_url_invalid',
        `the digest index published an unreadable address for ${context}: ${published}`,
        `${baseUrl}/apzvalgos/index.json`);
    }
    if (resolved.origin !== new URL(baseUrl).origin) {
      throw new ArchiveApiError(200, 'edition_url_off_origin',
        `the digest index published an address on another host and it was refused: ${published}`,
        `${baseUrl}/apzvalgos/index.json`);
    }
    return resolved.pathname + resolved.search;
  }

  /** One daily edition, addressed the way the SITE says to address it.
   *
   *  It would be shorter to build `edition-<compact-timestamp>.json` from the window end, and
   *  that is exactly the bug this replaced: `window_end_utc` is `2026-09-06T02:00:00Z` while
   *  the file is `edition-20260906T020000Z.json`, so every derived address 404'd - 85 of 85,
   *  measured against the live host. Re-deriving a filename is a SECOND naming rule that can
   *  disagree with the site's own, and when it disagrees the site is right. So we read the
   *  `url` the index publishes and follow that, and the selector is matched against the three
   *  identifiers a caller could plausibly be holding.
   *
   *  Costs one extra request. That is the price of not having a private opinion about how the
   *  other side names its files. */
  async function digest(selector) {
    const wanted = String(selector);
    const index = await fetchStatic('/apzvalgos/index.json');
    const editions = Array.isArray(index.editions) ? index.editions : [];
    const found = editions.find((edition) => wanted === edition.date
      || wanted === edition.window_end_utc
      || wanted === String(edition.window_end_utc || '').replace(/[-:]/g, ''));
    if (!found) {
      const known = editions.slice(0, 3).map((edition) => edition.date).join(', ');
      throw new ArchiveApiError(404, 'edition_not_found',
        `no published edition matches "${wanted}"`
        + (known ? `; the newest are ${known} (a date works, so does its window_end_utc)` : ''),
        `${baseUrl}/apzvalgos/index.json`);
    }
    return fetchStatic(resolveStatic(found.url, found.date || wanted));
  }

  return {
    baseUrl,
    urlFor,
    index: () => request('', {}),
    messages: (params = {}) => request('messages', params),
    search: (params = {}) => request('search', params),
    message: (params = {}) => request('message', params),
    // The two shelves: every shared link, and every approved attachment, apart from the
    // message pool and each row carrying the machine-written description of what it is.
    // Metadata only - media() is still the one way to fetch bytes, under its own cap.
    links: (params = {}) => request('links', params),
    files: (params = {}) => request('files', params),
    media,
    digestIndex: () => fetchStatic('/apzvalgos/index.json'),
    digest,
  };
}

module.exports = {createArchiveClient, ArchiveApiError, MEDIA_MAX_BYTES, DEFAULT_BASE_URL, USER_AGENT};
