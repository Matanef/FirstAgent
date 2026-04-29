# Sci-Hub / LibGen Feasibility Research

**Status:** Research-only document. No code has been added to the agent for Sci-Hub or torrent integration. Read this, decide whether to proceed, then either:
- Greenlight an HTTP-scrape Sci-Hub fetcher (would land in `articleHarvester.js`), OR
- Greenlight a LibGen scientific-article fetcher, OR
- Decline and stick with the existing DOI-resolver + open-access-only flow.

---

## 1. Current state in this repo

- `articleHarvester.js` resolves papers via:
  - Semantic Scholar (DOI + open-access URL)
  - arXiv (free preprints)
  - Europe PMC (free biomed)
  - DOAJ (open-access journals)
  - CORE (open-access aggregator)
  - Wikipedia (background context)
  - Google Scholar via SerpAPI (often surfaces direct PDF links from university repositories)
- For full-text retrieval, `fetchPage()` (lines 553–581) does an HTTP GET on the URL with a 3MB content limit and 18s timeout.
- **No paywall bypass exists.** Closed-access papers either surface as abstract-only (Semantic Scholar) or fail to scrape.

---

## 2. Mirror landscape (April 2026)

### Sci-Hub
- Primary front-ends rotate frequently. The most stable as of writing: `sci-hub.se`, `sci-hub.ru`, `sci-hub.st`, `sci-hub.ee`.
- Founder Alexandra Elbakyan publishes mirror updates on her Twitter/X. Community-maintained mirror lists: `https://www.sci-hub.pub/mirrors`, `https://lovescihub.wordpress.com`.
- Some mirrors are frequently DNS-blocked by ISPs in EU/UK/US — depending on user's network this affects success rates without notice.
- Sci-Hub stopped adding NEW papers (post-Dec 2020) due to a court injunction. Anything published 2021+ is unlikely to be on Sci-Hub. Use cases skewed toward older literature.

### LibGen (Library Genesis)
- `libgen.is`, `libgen.rs`, `libgen.li` — book-focused but has a "scimag" sub-collection of ~88M scientific articles indexed by DOI.
- LibGen is more reliable than Sci-Hub for active maintenance and accepts DOI-based lookup: `https://libgen.is/scimag/?q=10.1038/nature12373`.
- Returns torrent links AND HTTP mirrors. The HTTP mirrors are often what get scraped.

---

## 3. Integration options

### Option A — HTTP-scrape Sci-Hub mirrors (LOW effort, MEDIUM reliability)

**Sketch (no code yet):**

```js
// Add to articleHarvester.js, called when fetchPage() returns empty/paywalled
async function fetchViaSciHub(doi) {
  const mirrors = ["https://sci-hub.se", "https://sci-hub.ru", "https://sci-hub.st"];
  for (const mirror of mirrors) {
    try {
      const html = (await axios.get(`${mirror}/${doi}`, { timeout: 12000 })).data;
      // Sci-Hub embeds the PDF in an <iframe id="pdf"> or <embed> tag
      const m = html.match(/<(?:iframe|embed)[^>]+src="([^"]+\.pdf[^"]*)"/i);
      if (m) {
        const pdfUrl = m[1].startsWith("//") ? "https:" + m[1] : m[1];
        return { url: pdfUrl, source: `scihub:${new URL(mirror).host}` };
      }
    } catch { /* try next mirror */ }
  }
  return null;
}
```

**Trigger point:** in `fetchPage()` (line 553) — if the original URL fails or returns < 1KB of text AND the article has a DOI, call `fetchViaSciHub(doi)` as a fallback. Cache the resulting PDF URL in `server/data/research-cache/` so repeat lookups don't re-scrape.

**Dependencies:** zero new deps. Uses `axios` (already on the allowlist).

**Risks:**
- Mirrors go up/down without notice. Need a periodic mirror-list refresh (or hard-fail and degrade).
- Some mirrors return Cloudflare challenges → can't scrape headlessly with axios. Detection: check for `<title>Just a moment...</title>` and skip that mirror.
- DNS blocking at user's ISP layer can silently drop these requests. Recommend logging mirror-by-mirror outcomes.

### Option B — HTTP-scrape LibGen scimag (LOW effort, HIGH reliability)

**Sketch:**

```js
async function fetchViaLibgen(doi) {
  // Search by DOI
  const search = await axios.get(`https://libgen.is/scimag/?q=${encodeURIComponent(doi)}`, { timeout: 12000 });
  // The result page has <a href="ads.php?doi=...">title</a>; the ads page has GET mirrors
  const m = search.data.match(/href="(ads\.php\?doi=[^"]+)"/);
  if (!m) return null;
  const adsHtml = (await axios.get(`https://libgen.is/scimag/${m[1]}`, { timeout: 12000 })).data;
  // The first GET mirror is typically library.lol or sci-hub-derived
  const mirror = adsHtml.match(/href="(https?:\/\/[^"]+\.pdf[^"]*)"/);
  return mirror ? { url: mirror[1], source: "libgen.is" } : null;
}
```

**Why this is better than A:**
- Single domain, much more stable than Sci-Hub mirrors.
- Indexes DOIs explicitly — exact match instead of fuzzy mirror probing.
- LibGen scimag is the *source* most Sci-Hub mirrors actually proxy from, so going direct is faster + more reliable.

**Risks:**
- LibGen has had brief outages but is generally up.
- Same Cloudflare risk — if it appears, we degrade.
- Some PDFs hosted on third-party mirrors (`library.lol`, `cdn1.booksdl.org`) which themselves rotate.

### Option C — Torrent integration (HIGH effort, REJECTED for this repo)

**CLAUDE.md rule:** Allowed npm packages are strictly `agent-twitter-client, axios, lodash, ngrok`. Torrent libraries (`webtorrent`, `bittorrent-tracker`, `parse-torrent`) are **forbidden**.

To pursue torrent, the user would need to either:
1. Amend `CLAUDE.md` to add torrent libs to the allowlist (defeats the purpose of the allowlist), OR
2. Run a separate sidecar service (e.g. a small Python or Go process that owns torrent fetches and exposes an HTTP API the agent can call). This is a non-trivial architectural change and is out of scope for the deepResearch hardening pass.

**Recommendation:** Don't pursue torrents from inside the Node.js agent. If torrent access is critical, build it as an external service.

---

## 4. Operational considerations

### Caching
- `server/data/research-cache/` already exists. Sci-Hub/LibGen lookups should:
  - Cache by DOI → PDF URL mapping (key: DOI hash, value: `{ url, fetchedAt, source }`).
  - Cache the PDF binary itself (size cap: 10MB per file, total cap: 1GB before LRU eviction).
  - Don't re-scrape if cached < 30 days old.
- This keeps repeat lookups fast AND reduces load on free mirrors (good citizenship).

### Legal / operational notes
- **Don't claim user's IP.** No need for proxies — the user's own IP is what's making the request. This is the same posture as if the user had typed the URL into their own browser.
- **Don't redistribute.** The cache is for the user's personal use, NOT for serving to other users via the agent's API.
- **Respect mirror availability.** Add a max-3-attempts-per-DOI rule to avoid hammering a struggling mirror.

### Logging
Whatever option lands, log:
```
[harvester] paywall fallback: tried libgen for doi=10.x/y → SUCCESS (3.2MB pdf, 4.1s)
[harvester] paywall fallback: tried scihub.se for doi=10.x/y → 503, tried scihub.ru → SUCCESS (1.8MB)
```

This makes future debugging easy and surfaces mirror-health trends.

---

## 5. Recommendation

**Ship Option B (LibGen scimag)** as a follow-up task. It's:
- Lowest-effort to implement (~80 lines of new code in `articleHarvester.js`).
- Highest reliability (single domain, DOI-keyed).
- Zero new dependencies (axios only).
- Easy to disable (env flag `ENABLE_LIBGEN_FALLBACK=true` gates it).

**Skip Option A (Sci-Hub).** It overlaps in coverage with LibGen but with worse UX (mirror probing, Cloudflare challenges).

**Skip Option C (torrent).** Violates the package allowlist. Out of scope.

If user greenlights B, the implementation will:
1. Add `fetchViaLibgen(doi)` helper to `articleHarvester.js`.
2. Wire it into `fetchPage()` as a fallback when:
   - The original URL returns < 500 bytes of usable content AND
   - The article has a DOI AND
   - `CONFIG.ENABLE_LIBGEN_FALLBACK === "true"`.
3. Cache results in `server/data/research-cache/libgen/<doi-hash>.json`.
4. Log per-DOI success/failure for observability.
5. Add to the startup `[harvester] enabled providers:` log line as `libgen-fallback`.

Estimated effort: ~1 hour, single-file change.
