/**
 * twitter-client.js — Standalone Twitter/X API client
 *
 * Replaces the broken `agent-twitter-client` library with direct API calls
 * to Twitter's internal web API (twitter.com/i/api/).
 *
 * Why this exists:
 *   - agent-twitter-client@0.0.18's bearer token was revoked by Twitter
 *   - api.twitter.com domain is fully deprecated (returns 404)
 *   - The library's GraphQL operation hashes are outdated
 *   - Twitter now requires a browser user-agent header
 *   - The UserByScreenName response format changed (screen_name removed from legacy)
 *
 * This client handles:
 *   1. Cookie-based authentication (no passwords needed)
 *   2. Bearer token (X.com web app bearer)
 *   3. GraphQL hash extraction from live JS bundle (auto-update)
 *   4. Proper header injection (user-agent, csrf, auth-type)
 *   5. Cookie domain normalization (.x.com → .twitter.com)
 *   6. Trends, Search, Profile, Tweet detail endpoints
 *
 * Usage:
 *   import { TwitterClient } from './twitter-client.js';
 *   const client = new TwitterClient({ cookiePath: './twitter_cookies.json' });
 *   await client.init();
 *   const trends = await client.getTrends();
 *   const tweets = await client.search('hello', 10);
 *   const profile = await client.getProfile('elonmusk');
 *
 * Cookie file format (JSON array of Set-Cookie strings):
 *   [
 *     "auth_token=xxx; Domain=.x.com; Path=/; Secure; HttpOnly",
 *     "ct0=xxx; Domain=.x.com; Path=/; Secure",
 *     "twid=u%3Dxxx; Domain=.x.com; Path=/; Secure"
 *   ]
 *
 * @module twitter-client
 * @version 1.0.0
 * @license MIT
 */

import fs from "fs/promises";

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** The X.com web app bearer token — used as a "client identifier" */
const WEB_BEARER = decodeURIComponent(
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
);

/** Browser user-agent — Twitter returns 404 without one */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

/** Base URL for Twitter's internal API */
const API_BASE = "https://twitter.com/i/api";

/** URL to extract GraphQL hashes from */
const TWITTER_HOME = "https://twitter.com/";

/** Cache duration for GraphQL hashes (4 hours) */
const HASH_CACHE_TTL = 4 * 60 * 60 * 1000;

/** Default features for GraphQL queries */
const DEFAULT_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

/** Profile-specific features */
const PROFILE_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

// ═══════════════════════════════════════════════════════════════
// GRAPHQL HASH CACHE
// ═══════════════════════════════════════════════════════════════

let cachedHashes = null;
let hashCacheTime = 0;

/**
 * Extract current GraphQL operation hashes from Twitter's web app JS bundle.
 * Twitter rotates these periodically, so we fetch them live.
 * @returns {Promise<Object>} Map of operation name → hash
 */
async function fetchGraphQLHashes() {
  const now = Date.now();
  if (cachedHashes && (now - hashCacheTime) < HASH_CACHE_TTL) {
    return cachedHashes;
  }

  console.log("🐦 [twitter-client] Fetching current GraphQL hashes from twitter.com...");

  try {
    const mainRes = await fetch(TWITTER_HOME, {
      headers: { "user-agent": USER_AGENT },
    });
    const html = await mainRes.text();

    // Find JS bundle URLs
    const jsUrls = [
      ...html.matchAll(
        /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"]+\.js)"/g
      ),
    ].map((m) => m[1]);

    const hashes = {};
    const opsToFind = [
      "SearchTimeline",
      "UserByScreenName",
      "TweetDetail",
      "UserTweets",
      "UserTweetsAndReplies",
      "Followers",
      "Following",
      "Likes",
      "CreateTweet",
      "DeleteTweet",
      "FavoriteTweet",
      "UnfavoriteTweet",
      "CreateRetweet",
      "DeleteRetweet",
    ];

    for (const url of jsUrls) {
      try {
        const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
        const js = await res.text();

        for (const op of opsToFind) {
          if (hashes[op]) continue;
          const match = js.match(
            new RegExp(`queryId:"([^"]+)"[^}]*?operationName:"${op}"`)
          );
          if (match) {
            hashes[op] = match[1];
          }
        }
      } catch (e) {
        console.warn(`🐦 [twitter-client] Failed to fetch bundle: ${e.message}`);
      }
    }

    console.log(
      `🐦 [twitter-client] Found ${Object.keys(hashes).length} GraphQL hashes:`,
      Object.entries(hashes)
        .map(([k, v]) => `${k}=${v.substring(0, 8)}...`)
        .join(", ")
    );

    if (Object.keys(hashes).length > 0) {
      cachedHashes = hashes;
      hashCacheTime = now;
    }

    return hashes;
  } catch (e) {
    console.error("🐦 [twitter-client] Hash extraction failed:", e.message);
    // Return stale cache if available
    return cachedHashes || {};
  }
}

// ═══════════════════════════════════════════════════════════════
// TWITTER CLIENT
// ═══════════════════════════════════════════════════════════════

export class TwitterClient {
  /**
   * @param {Object} options
   * @param {string} options.cookiePath - Path to JSON cookie file
   * @param {string} [options.bearerToken] - Override bearer token
   */
  constructor(options = {}) {
    this.cookiePath = options.cookiePath;
    this.bearerToken = options.bearerToken || WEB_BEARER;
    this.cookies = {}; // { auth_token, ct0, twid }
    this.hashes = {};
    this.initialized = false;
  }

  // ─────────────────────────────────────────────────────────────
  // INITIALIZATION
  // ─────────────────────────────────────────────────────────────

  /**
   * Initialize the client: load cookies and fetch GraphQL hashes.
   * Must be called before making API requests.
   */
  async init() {
    await this.loadCookies();
    this.hashes = await fetchGraphQLHashes();
    this.initialized = true;
    console.log("🐦 [twitter-client] Initialized successfully.");
  }

  /**
   * Load and normalize cookies from the cookie file.
   */
  async loadCookies() {
    if (!this.cookiePath) {
      throw new Error("cookiePath is required");
    }

    const raw = JSON.parse(await fs.readFile(this.cookiePath, "utf8"));

    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("Cookie file must be a non-empty JSON array");
    }

    // Parse cookies — support Set-Cookie strings or {key/name, value} objects
    for (const entry of raw) {
      if (typeof entry === "string") {
        const match = entry.match(/^([^=]+)=([^;]+)/);
        if (match) {
          this.cookies[match[1].trim()] = match[2].trim();
        }
      } else if (typeof entry === "object") {
        const key = entry.key || entry.name;
        if (key && entry.value) {
          this.cookies[key] = entry.value;
        }
      }
    }

    if (!this.cookies.auth_token || !this.cookies.ct0) {
      throw new Error(
        "Cookie file must contain at least auth_token and ct0. " +
          "Extract them from browser DevTools → Application → Cookies → twitter.com"
      );
    }

    console.log(
      `🐦 [twitter-client] Loaded ${Object.keys(this.cookies).length} cookies ` +
        `(auth_token=${this.cookies.auth_token.substring(0, 8)}..., ct0=${this.cookies.ct0.substring(0, 8)}...)`
    );
  }

  // ─────────────────────────────────────────────────────────────
  // HTTP PRIMITIVES
  // ─────────────────────────────────────────────────────────────

  /** Build the standard headers for authenticated Twitter API requests */
  _headers() {
    return {
      authorization: `Bearer ${this.bearerToken}`,
      cookie: Object.entries(this.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
      "x-csrf-token": this.cookies.ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      "user-agent": USER_AGENT,
    };
  }

  /**
   * Make an authenticated GET request to the Twitter API.
   * @param {string} path - API path (e.g., "/1.1/trends/place.json?id=1")
   * @returns {Promise<Object>} Parsed JSON response
   */
  async apiGet(path) {
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twitter API ${res.status}: ${text.substring(0, 200)}`);
    }
    return res.json();
  }

  /**
   * Make an authenticated GraphQL request.
   * @param {string} operationName - e.g., "SearchTimeline"
   * @param {Object} variables - GraphQL variables
   * @param {Object} [features] - Feature flags (defaults to DEFAULT_FEATURES)
   * @param {Object} [fieldToggles] - Field toggles
   * @returns {Promise<Object>} Parsed JSON response
   */
  async graphql(operationName, variables, features, fieldToggles) {
    const hash = this.hashes[operationName];
    if (!hash) {
      throw new Error(
        `Unknown GraphQL operation: ${operationName}. ` +
          `Available: ${Object.keys(this.hashes).join(", ")}`
      );
    }

    const feats = features || DEFAULT_FEATURES;
    const endpoint = `${API_BASE}/graphql/${hash}/${operationName}`;

    // Try GET first, fall back to POST if 404.
    // Some operations (e.g., SearchTimeline) only work via POST now.
    const params = new URLSearchParams();
    params.set("variables", JSON.stringify(variables));
    params.set("features", JSON.stringify(feats));
    if (fieldToggles) {
      params.set("fieldToggles", JSON.stringify(fieldToggles));
    }

    let res = await fetch(`${endpoint}?${params.toString()}`, {
      headers: this._headers(),
    });

    // Fall back to POST if GET returns 404
    if (res.status === 404) {
      console.log(
        `🐦 [twitter-client] ${operationName} GET→404, retrying as POST...`
      );
      const body = { variables, features: feats };
      if (fieldToggles) body.fieldToggles = fieldToggles;

      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...this._headers(),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GraphQL ${operationName} ${res.status}: ${text.substring(0, 200)}`
      );
    }

    return res.json();
  }

  // ─────────────────────────────────────────────────────────────
  // HIGH-LEVEL API
  // ─────────────────────────────────────────────────────────────

  /**
   * Get trending topics (worldwide).
   * @returns {Promise<Array<{name: string, tweetVolume: number|null, url: string}>>}
   */
  async getTrends(woeid = 1) {
    const data = await this.apiGet(`/1.1/trends/place.json?id=${woeid}`);
    return (data[0]?.trends || []).map((t) => ({
      name: t.name,
      tweetVolume: t.tweet_volume || null,
      url: t.url || null,
    }));
  }

  /**
   * Search tweets.
   * @param {string} query - Search query
   * @param {number} [count=20] - Number of results
   * @param {"Top"|"Latest"|"People"|"Photos"|"Videos"} [product="Latest"] - Search tab
   * @returns {Promise<Array<Object>>} Array of tweet objects
   */
  async search(query, count = 20, product = "Latest") {
    const data = await this.graphql("SearchTimeline", {
      rawQuery: query,
      count,
      querySource: "typed_query",
      product,
    });

    const instructions =
      data?.data?.search_by_raw_query?.search_timeline?.timeline
        ?.instructions || [];

    const tweets = [];
    for (const inst of instructions) {
      const entries = inst.entries || [];
      for (const entry of entries) {
        const tweet = this._parseTweetEntry(entry);
        if (tweet) tweets.push(tweet);
      }
    }

    return tweets;
  }

  /**
   * Get a user profile by screen name.
   * @param {string} username - Twitter handle (without @)
   * @returns {Promise<Object>} Profile object
   */
  async getProfile(username) {
    const data = await this.graphql(
      "UserByScreenName",
      { screen_name: username, withSafetyModeUserFields: true },
      PROFILE_FEATURES,
      { withAuxiliaryUserLabels: false }
    );

    const result = data?.data?.user?.result;
    if (!result) {
      throw new Error(`User @${username} not found`);
    }

    return this._parseUser(result);
  }

  /**
   * Get a tweet by ID.
   * @param {string} tweetId - Tweet ID
   * @returns {Promise<Object>} Tweet object with replies
   */
  async getTweet(tweetId) {
    const data = await this.graphql("TweetDetail", {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
      withV2Timeline: true,
    });

    const instructions =
      data?.data?.threaded_conversation_with_injections_v2?.instructions || [];

    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        if (entry.entryId?.startsWith("tweet-")) {
          const tweet = this._parseTweetEntry(entry);
          if (tweet && tweet.id === tweetId) return tweet;
        }
      }
    }

    throw new Error(`Tweet ${tweetId} not found`);
  }

  /**
   * Get a user's tweets.
   * @param {string} userId - User ID (numeric)
   * @param {number} [count=20] - Number of tweets
   * @returns {Promise<Array<Object>>} Array of tweet objects
   */
  async getUserTweets(userId, count = 20) {
    const data = await this.graphql("UserTweets", {
      userId,
      count,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: true,
      withV2Timeline: true,
    });

    const instructions =
      data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];

    const tweets = [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const tweet = this._parseTweetEntry(entry);
        if (tweet) tweets.push(tweet);
      }
    }

    return tweets;
  }

  // ─────────────────────────────────────────────────────────────
  // RESPONSE PARSERS
  // ─────────────────────────────────────────────────────────────

  /**
   * Parse a timeline entry into a normalized tweet object.
   * Handles the various response formats Twitter uses.
   */
  _parseTweetEntry(entry) {
    // Direct tweet entry
    let result =
      entry?.content?.itemContent?.tweet_results?.result;

    // Module entry (search results)
    if (!result && entry?.content?.items) {
      for (const item of entry.content.items) {
        result = item?.item?.itemContent?.tweet_results?.result;
        if (result) break;
      }
    }

    if (!result) return null;

    // Handle "TweetWithVisibilityResults" wrapper
    if (result.__typename === "TweetWithVisibilityResults") {
      result = result.tweet;
    }

    if (!result || result.__typename !== "Tweet") return null;

    const legacy = result.legacy || {};
    const user = this._parseUser(result.core?.user_results?.result);

    return {
      id: result.rest_id || legacy.id_str,
      text: legacy.full_text || "",
      createdAt: legacy.created_at ? new Date(legacy.created_at) : null,
      user,
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      quotes: legacy.quote_count || 0,
      bookmarks: legacy.bookmark_count || 0,
      views: parseInt(result.views?.count) || 0,
      isRetweet: !!legacy.retweeted_status_result,
      isReply: !!legacy.in_reply_to_status_id_str,
      inReplyTo: legacy.in_reply_to_status_id_str || null,
      lang: legacy.lang || null,
      // Media
      media: (legacy.entities?.media || []).map((m) => ({
        type: m.type,
        url: m.media_url_https || m.url,
        expandedUrl: m.expanded_url,
      })),
      // URLs
      urls: (legacy.entities?.urls || []).map((u) => ({
        url: u.url,
        expanded: u.expanded_url,
        display: u.display_url,
      })),
    };
  }

  /**
   * Parse a user result object into a normalized profile.
   * Handles Twitter's response format where name/screen_name are in `core` (2025+),
   * and follower counts etc. are in `legacy`.
   */
  _parseUser(result) {
    if (!result) return null;

    const legacy = result.legacy || {};
    const core = result.core || {};

    // Name and screen_name:
    //   - 2025+ format: result.core.name, result.core.screen_name
    //   - Legacy format: result.legacy.name, result.legacy.screen_name
    //   - Nested tweet format: result.core.user_results.result.core.name
    const name =
      core.name ||
      legacy.name ||
      core.user_results?.result?.core?.name ||
      core.user_results?.result?.legacy?.name ||
      null;

    const screenName =
      core.screen_name ||
      legacy.screen_name ||
      core.user_results?.result?.core?.screen_name ||
      core.user_results?.result?.legacy?.screen_name ||
      null;

    // Created date: check core first (new format), then legacy
    const createdAtStr = core.created_at || legacy.created_at;

    return {
      id: result.rest_id || legacy.id_str,
      name,
      username: screenName,
      description: legacy.description || result.profile_bio?.description || "",
      location: legacy.location || result.location?.location || "",
      followers: legacy.followers_count || legacy.normal_followers_count || 0,
      following: legacy.friends_count || 0,
      tweets: legacy.statuses_count || 0,
      likes: legacy.favourites_count || 0,
      listed: legacy.listed_count || 0,
      verified: result.is_blue_verified || false,
      profileImage:
        legacy.profile_image_url_https ||
        result.avatar?.image_url ||
        null,
      profileBanner: legacy.profile_banner_url || null,
      createdAt: createdAtStr ? new Date(createdAtStr) : null,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // UTILITY
  // ─────────────────────────────────────────────────────────────

  /**
   * Check if the client is authenticated by making a lightweight API call.
   * @returns {Promise<boolean>}
   */
  async isAuthenticated() {
    try {
      // Use trends as a lightweight auth check
      await this.apiGet("/1.1/trends/place.json?id=1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Force refresh of GraphQL hashes from Twitter's JS bundle.
   */
  async refreshHashes() {
    hashCacheTime = 0;
    cachedHashes = null;
    this.hashes = await fetchGraphQLHashes();
  }
}

// ═══════════════════════════════════════════════════════════════
// CONVENIENCE EXPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Create and initialize a TwitterClient in one step.
 * @param {Object} options - Same as TwitterClient constructor
 * @returns {Promise<TwitterClient>}
 */
export async function createTwitterClient(options) {
  const client = new TwitterClient(options);
  await client.init();
  return client;
}

export default TwitterClient;
