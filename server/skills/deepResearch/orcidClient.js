// server/skills/deepResearch/orcidClient.js
// Phase 19A — ORCID Public API v3.0 client.
//
// Used as a citation rescue path: when the article harvester returns metadata
// with a malformed authors list (e.g. 88 single-token "authors" — a Cochrane
// review with comma-tokenized last names) we look the work up via ORCID by DOI
// and recover a clean author list.
//
// Auth: ORCID issues Client ID + Client Secret pairs; we exchange them for a
// long-lived public-read access token via the OAuth2 client_credentials flow,
// then cache that token in memory for the process lifetime.
// Public-read tokens are valid ~20 years per ORCID's policy, so we don't need
// refresh logic in practice.
//
// Allowed dependency surface (per CLAUDE.md): axios + node built-ins only.

import axios from "axios";

const ORCID_BASE = "https://pub.orcid.org/v3.0";
const ORCID_OAUTH_URL = "https://orcid.org/oauth/token";

const CLIENT_ID = process.env.ORCID_CLIENT_ID || null;
const CLIENT_SECRET = process.env.ORCID_CLIENT_SECRET || null;
// Optional pre-fetched token override (skips the OAuth exchange)
const STATIC_TOKEN = process.env.ORCID_ACCESS_TOKEN || null;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;    // 24h author/work lookup cache
const _lookupCache = new Map();              // key: query/identifier, val: { data, expiresAt }
let _accessToken = STATIC_TOKEN;
let _tokenFetchPromise = null;               // in-flight token request guard

function cacheGet(key) {
  const v = _lookupCache.get(key);
  if (v && v.expiresAt > Date.now()) return v.data;
  return null;
}
function cacheSet(key, value) {
  _lookupCache.set(key, { data: value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Exchange ORCID Client ID + Secret for a /read-public access token.
 * Cached after first call. Returns null if creds aren't configured.
 */
export async function getAccessToken() {
  if (_accessToken) return _accessToken;
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  // Single-flight: many concurrent ORCID calls during citation index build
  // should share one token-exchange request.
  if (_tokenFetchPromise) return _tokenFetchPromise;
  _tokenFetchPromise = (async () => {
    try {
      const params = new URLSearchParams();
      params.append("client_id", CLIENT_ID);
      params.append("client_secret", CLIENT_SECRET);
      params.append("grant_type", "client_credentials");
      params.append("scope", "/read-public");
      const res = await axios.post(ORCID_OAUTH_URL, params.toString(), {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 20000
      });
      _accessToken = res.data?.access_token || null;
      if (_accessToken) {
        console.log(`[orcid] token exchange OK (scope=/read-public, expires_in=${res.data?.expires_in || "unknown"}s)`);
      } else {
        console.warn(`[orcid] token exchange returned no access_token`);
      }
      return _accessToken;
    } catch (err) {
      console.warn(`[orcid] token exchange failed: ${err.message}`);
      return null;
    } finally {
      _tokenFetchPromise = null;
    }
  })();
  return _tokenFetchPromise;
}

/**
 * Lazy-build the auth headers. Public-read works with no token at lower
 * rate limits, so we degrade gracefully if creds aren't set.
 */
async function buildHeaders() {
  const token = await getAccessToken();
  return token
    ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
    : { Accept: "application/json" };
}

/**
 * Search ORCID by family name (+ optional given names). Returns up to `rows`
 * candidate ORCID iDs ranked by ORCID's own relevance score.
 */
export async function searchAuthor({ familyName, givenNames = "", rows = 5 }) {
  if (!familyName) return [];
  const cacheKey = `s|${familyName}|${givenNames}|${rows}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const headers = await buildHeaders();
    const qParts = [`family-name:${encodeURIComponent(familyName)}`];
    if (givenNames) qParts.push(`given-names:${encodeURIComponent(givenNames)}`);
    const q = qParts.join("+AND+");
    const res = await axios.get(`${ORCID_BASE}/expanded-search/?q=${q}&rows=${rows}`, {
      headers,
      timeout: 15000
    });
    const out = (res.data?.["expanded-result"] || []).map(r => ({
      orcid: r["orcid-id"],
      givenNames: r["given-names"] || "",
      familyNames: r["family-names"] || "",
      affiliations: Array.isArray(r["institution-name"]) ? r["institution-name"].slice(0, 3) : [],
    }));
    cacheSet(cacheKey, out);
    return out;
  } catch (err) {
    console.warn(`[orcid] searchAuthor failed for "${familyName}": ${err.message}`);
    return [];
  }
}

/**
 * Look up a work by DOI across an author's ORCID record. Returns the
 * canonical author list if the DOI matches.
 *
 * Strategy:
 *   1. Search ORCID by family name (top 3 candidates).
 *   2. For each candidate, fetch /works and look for a matching DOI.
 *   3. On match, fetch the full work record to extract its contributors list.
 *
 * Returns: { verified: bool, orcid?: string, authors?: string[] }
 */
export async function verifyByDoi({ doi, firstAuthorFamily, firstAuthorGiven = "" }) {
  if (!doi || !firstAuthorFamily) return { verified: false };
  const cacheKey = `v|${doi.toLowerCase()}|${firstAuthorFamily.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const candidates = await searchAuthor({
      familyName: firstAuthorFamily,
      givenNames: firstAuthorGiven,
      rows: 3
    });
    if (candidates.length === 0) {
      const out = { verified: false };
      cacheSet(cacheKey, out);
      return out;
    }
    const headers = await buildHeaders();
    for (const c of candidates) {
      try {
        const worksRes = await axios.get(`${ORCID_BASE}/${c.orcid}/works`, {
          headers,
          timeout: 15000
        });
        const groups = worksRes.data?.group || [];
        const hit = groups.find(g => {
          const eids = g["external-ids"]?.["external-id"] || [];
          return eids.some(eid =>
            String(eid["external-id-type"]).toLowerCase() === "doi" &&
            String(eid["external-id-value"]).toLowerCase() === doi.toLowerCase()
          );
        });
        if (!hit) continue;
        // Fetch the full work to extract its contributors list
        const summary = hit["work-summary"]?.[0];
        const putCode = summary?.["put-code"];
        if (!putCode) continue;
        try {
          const workRes = await axios.get(`${ORCID_BASE}/${c.orcid}/work/${putCode}`, {
            headers,
            timeout: 15000
          });
          const contribs = workRes.data?.contributors?.contributor || [];
          const authors = contribs
            .map(co => co["credit-name"]?.value)
            .filter(s => typeof s === "string" && s.trim().length > 0);
          if (authors.length > 0) {
            const out = { verified: true, orcid: c.orcid, authors };
            cacheSet(cacheKey, out);
            return out;
          }
        } catch { /* fall through to next candidate */ }
      } catch { /* skip candidate */ }
    }
    const out = { verified: false };
    cacheSet(cacheKey, out);
    return out;
  } catch (err) {
    console.warn(`[orcid] verifyByDoi failed for ${doi}: ${err.message}`);
    return { verified: false };
  }
}

/**
 * Best-effort author-list rescue. Used by citations.js when the harvested
 * authors list looks malformed (single-token Cochrane-style author lists).
 *
 * Returns: cleaned authors list or null if rescue not possible.
 */
export async function rescueAuthors({ doi, malformedAuthors, title }) {
  // Need a DOI and at least one usable name fragment to anchor the search.
  if (!doi) return null;
  // Pick the longest single-token "author" as the search seed — Cochrane-style
  // lists often have 50+ entries, with the most-cited author appearing first.
  const seed = (malformedAuthors || []).find(a => typeof a === "string" && a.trim().length >= 3);
  if (!seed) return null;
  const seedFamily = String(seed).trim().split(/[\s,]+/)[0];
  if (!seedFamily || seedFamily.length < 3) return null;
  const result = await verifyByDoi({ doi, firstAuthorFamily: seedFamily });
  if (result.verified && Array.isArray(result.authors) && result.authors.length > 0) {
    console.log(`[orcid] rescued authors for "${String(title || "").slice(0, 50)}" via DOI=${doi} → ${result.authors.length} canonical author(s)`);
    return result.authors;
  }
  return null;
}

/**
 * Test-friendly: clear in-memory caches (token + lookup).
 * Not used in production, only by tests.
 */
export function _resetForTests() {
  _accessToken = STATIC_TOKEN;
  _lookupCache.clear();
}

/**
 * Surface a configuration-status flag so callers (and tests) can detect
 * whether ORCID is wired up at all.
 */
export function isConfigured() {
  return Boolean(STATIC_TOKEN || (CLIENT_ID && CLIENT_SECRET));
}
