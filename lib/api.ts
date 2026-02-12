/**
 * X/Twitter scraper wrapper — search, threads, profiles, single tweets.
 * Uses @the-convocation/twitter-scraper for profiles/tweets/timelines.
 * Search uses a direct GraphQL call (library's hash gets stale).
 *
 * Auth priority:
 *   1. Saved cookies in data/cookies.json (from prior session)
 *   2. TWITTER_COOKIES env var: "auth_token=XXX; ct0=YYY"
 *   3. Fresh login via TWITTER_USERNAME + TWITTER_PASSWORD + TWITTER_EMAIL
 *      (may fail due to Arkose CAPTCHA — cookie auth is preferred)
 */

import { Scraper, SearchMode } from "@the-convocation/twitter-scraper";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const COOKIES_PATH = join(DATA_DIR, "cookies.json");

// Twitter's internal bearer token (same one the web client uses)
const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// Current SearchTimeline GraphQL hash — update when Twitter rotates it.
// Source: https://github.com/fa0311/TwitterInternalAPIDocument/blob/master/docs/markdown/GraphQL.md
const SEARCH_HASH = "IzA05zAvo7MGeZrkQmIVvw";

export interface Tweet {
  id: string;
  text: string;
  author_id: string;
  username: string;
  name: string;
  created_at: string;
  conversation_id: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    impressions: number;
    bookmarks: number;
  };
  urls: string[];
  mentions: string[];
  hashtags: string[];
  tweet_url: string;
}

/**
 * Read an env var from process.env or ~/.config/env/global.env.
 */
function readEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const envFile = readFileSync(
      `${process.env.HOME}/.config/env/global.env`,
      "utf-8"
    );
    const m = envFile.match(new RegExp(`${name}=["']?([^"'\\n]+)`));
    if (m) return m[1];
  } catch {}
  return undefined;
}

/**
 * Build cookie strings from TWITTER_COOKIES env var.
 * Accepts format: "auth_token=XXX; ct0=YYY"
 */
function parseCookieEnv(raw: string): string[] {
  const cookies: string[] = [];
  const pairs = raw
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    cookies.push(`${name}=${value}; Domain=.x.com; Path=/`);
  }
  return cookies;
}

let _scraper: Scraper | null = null;
let _authToken: string | null = null;
let _ct0: string | null = null;

async function getScraper(): Promise<Scraper> {
  if (_scraper) return _scraper;

  const scraper = new Scraper();

  // 1. Try saved cookies file
  if (existsSync(COOKIES_PATH)) {
    try {
      const saved = JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));
      await scraper.setCookies(saved);
      if (await scraper.isLoggedIn()) {
        await extractTokens(scraper);
        _scraper = scraper;
        return scraper;
      }
    } catch {
      // Cookies invalid/expired, continue
    }
  }

  // 2. Try TWITTER_COOKIES env var (browser-exported cookies)
  const cookieEnv = readEnv("TWITTER_COOKIES");
  if (cookieEnv) {
    try {
      const cookieStrings = parseCookieEnv(cookieEnv);
      await scraper.setCookies(cookieStrings);
      if (await scraper.isLoggedIn()) {
        saveCookies(scraper);
        await extractTokens(scraper);
        _scraper = scraper;
        return scraper;
      }
    } catch {
      // Invalid cookies, continue
    }
  }

  // 3. Fallback: fresh login (may fail due to Arkose CAPTCHA)
  const username = readEnv("TWITTER_USERNAME");
  const password = readEnv("TWITTER_PASSWORD");
  const email = readEnv("TWITTER_EMAIL");

  if (!username || !password) {
    throw new Error(
      "Twitter auth failed. Set TWITTER_COOKIES (preferred) or TWITTER_USERNAME + TWITTER_PASSWORD in env or ~/.config/env/global.env.\n" +
        "To get cookies: log into x.com in browser → DevTools → Application → Cookies → copy auth_token and ct0 values.\n" +
        'Then set: TWITTER_COOKIES="auth_token=XXX; ct0=YYY"'
    );
  }

  await scraper.login(username, password, email);

  if (!(await scraper.isLoggedIn())) {
    throw new Error(
      "Twitter login failed (likely Arkose CAPTCHA). Use cookie auth instead:\n" +
        "1. Log into x.com in browser\n" +
        "2. DevTools → Application → Cookies → copy auth_token and ct0\n" +
        '3. Set TWITTER_COOKIES="auth_token=XXX; ct0=YYY" in ~/.config/env/global.env'
    );
  }

  saveCookies(scraper);
  await extractTokens(scraper);
  _scraper = scraper;
  return scraper;
}

async function extractTokens(scraper: Scraper) {
  const cookies = await scraper.getCookies();
  for (const c of cookies) {
    const key = (c as any).key || (c as any).name;
    const val = (c as any).value;
    if (key === "auth_token") _authToken = val;
    if (key === "ct0") _ct0 = val;
  }
}

function saveCookies(scraper: Scraper) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    scraper.getCookies().then((cookies) => {
      writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    });
  } catch {}
}

// --- Search via direct GraphQL (bypasses library's stale hash) ---

const SEARCH_FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

interface SearchResult {
  tweets: Tweet[];
  cursor?: string;
}

async function rawSearchTimeline(
  query: string,
  count: number,
  product: "Top" | "Latest",
  cursor?: string
): Promise<SearchResult> {
  // Ensure we're authenticated
  await getScraper();

  const variables: any = {
    rawQuery: query,
    count,
    querySource: "typed_query",
    product,
    withGrokTranslatedBio: false,
  };
  if (cursor) variables.cursor = cursor;

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(SEARCH_FEATURES),
  });

  const url = `https://x.com/i/api/graphql/${SEARCH_HASH}/SearchTimeline?${params}`;

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${decodeURIComponent(BEARER_TOKEN)}`,
      "x-csrf-token": _ct0!,
      cookie: `auth_token=${_authToken}; ct0=${_ct0}`,
      "content-type": "application/json",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Search API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return parseSearchResponse(json);
}

function parseSearchResponse(json: any): SearchResult {
  const tweets: Tweet[] = [];
  let nextCursor: string | undefined;

  const instructions =
    json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ||
    [];

  for (const inst of instructions) {
    const entries = inst.entries || [];
    for (const entry of entries) {
      // Tweet entries
      if (entry.entryId?.startsWith("tweet-")) {
        const result =
          entry.content?.itemContent?.tweet_results?.result;
        const t = extractTweetFromResult(result);
        if (t) tweets.push(t);
      }
      // Cursor for pagination
      if (entry.entryId?.startsWith("cursor-bottom")) {
        nextCursor = entry.content?.value;
      }
    }
  }

  return { tweets, cursor: nextCursor };
}

function extractTweetFromResult(result: any): Tweet | null {
  if (!result) return null;

  // Handle tombstone / unavailable tweets
  if (result.__typename === "TweetWithVisibilityResults") {
    result = result.tweet;
  }
  if (!result?.core?.user_results?.result?.legacy) return null;

  const legacy = result.legacy;
  const userLegacy = result.core.user_results.result.legacy;
  const metrics = legacy.public_metrics || {};

  return {
    id: legacy.id_str || result.rest_id,
    text: legacy.full_text || "",
    author_id: legacy.user_id_str || "",
    username: userLegacy.screen_name || "?",
    name: userLegacy.name || "?",
    created_at: legacy.created_at
      ? new Date(legacy.created_at).toISOString()
      : "",
    conversation_id: legacy.conversation_id_str || "",
    metrics: {
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      quotes: legacy.quote_count || 0,
      impressions: result.views?.count
        ? parseInt(result.views.count)
        : 0,
      bookmarks: legacy.bookmark_count || 0,
    },
    urls: (legacy.entities?.urls || [])
      .map((u: any) => u.expanded_url)
      .filter(Boolean),
    mentions: (legacy.entities?.user_mentions || [])
      .map((m: any) => m.screen_name)
      .filter(Boolean),
    hashtags: (legacy.entities?.hashtags || [])
      .map((h: any) => h.text)
      .filter(Boolean),
    tweet_url: `https://x.com/${userLegacy.screen_name}/status/${legacy.id_str || result.rest_id}`,
  };
}

// --- Map scraper tweet objects to our Tweet interface ---

function mapTweet(raw: any): Tweet | null {
  if (!raw || !raw.id) return null;

  return {
    id: raw.id,
    text: raw.text || "",
    author_id: raw.userId || "",
    username: raw.username || "?",
    name: raw.name || raw.username || "?",
    created_at: raw.timeParsed
      ? new Date(raw.timeParsed).toISOString()
      : raw.timestamp
        ? new Date(raw.timestamp * 1000).toISOString()
        : "",
    conversation_id: raw.conversationId || raw.id || "",
    metrics: {
      likes: raw.likes ?? 0,
      retweets: raw.retweets ?? 0,
      replies: raw.replies ?? 0,
      quotes: 0,
      impressions: raw.views ?? 0,
      bookmarks: raw.bookmarkCount ?? 0,
    },
    urls: raw.urls || [],
    mentions: (raw.mentions || [])
      .map((m: any) => (typeof m === "string" ? m : m.username) || "")
      .filter(Boolean),
    hashtags: raw.hashtags || [],
    tweet_url:
      raw.permanentUrl ||
      `https://x.com/${raw.username || "?"}/status/${raw.id}`,
  };
}

// --- Helpers ---

function parseSince(since: string): Date | null {
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    const ms =
      unit === "m"
        ? num * 60_000
        : unit === "h"
          ? num * 3_600_000
          : num * 86_400_000;
    return new Date(Date.now() - ms);
  }
  if (since.includes("T") || since.includes("-")) {
    try {
      return new Date(since);
    } catch {
      return null;
    }
  }
  return null;
}

function buildSinceOperator(since: string): string {
  const date = parseSince(since);
  if (!date) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return ` since:${yyyy}-${mm}-${dd}`;
}

// --- Public API ---

/**
 * Search recent tweets.
 */
export async function search(
  query: string,
  opts: {
    maxResults?: number;
    pages?: number;
    sortOrder?: "relevancy" | "recency";
    since?: string;
  } = {}
): Promise<Tweet[]> {
  const maxResults = Math.min(opts.maxResults || 100, 100);
  const pages = opts.pages || 1;
  const product = opts.sortOrder === "recency" ? "Latest" : "Top";

  let fullQuery = query;
  if (opts.since) {
    fullQuery += buildSinceOperator(opts.since);
  }

  let allTweets: Tweet[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < pages; page++) {
    const result = await rawSearchTimeline(
      fullQuery,
      maxResults,
      product as "Top" | "Latest",
      cursor
    );
    allTweets.push(...result.tweets);
    cursor = result.cursor;
    if (!cursor) break;
  }

  // Client-side sub-day filtering
  if (opts.since) {
    const cutoff = parseSince(opts.since);
    if (cutoff) {
      return allTweets.filter(
        (t) => t.created_at && new Date(t.created_at) >= cutoff
      );
    }
  }

  return allTweets;
}

/**
 * Fetch a full conversation thread by root tweet ID.
 */
export async function thread(
  conversationId: string,
  opts: { pages?: number } = {}
): Promise<Tweet[]> {
  const scraper = await getScraper();
  const result: Tweet[] = [];

  // Fetch root tweet
  const rootRaw = await scraper.getTweet(conversationId);
  if (rootRaw) {
    const root = mapTweet(rootRaw);
    if (root) result.push(root);

    if (rootRaw.thread && rootRaw.thread.length > 0) {
      for (const t of rootRaw.thread) {
        const mapped = mapTweet(t);
        if (mapped && mapped.id !== conversationId) result.push(mapped);
      }
    }
  }

  // Search for replies
  const maxReplies = (opts.pages || 2) * 100;
  try {
    const replyResult = await rawSearchTimeline(
      `conversation_id:${conversationId}`,
      maxReplies,
      "Latest"
    );
    const seenIds = new Set(result.map((t) => t.id));
    for (const t of replyResult.tweets) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        result.push(t);
      }
    }
  } catch {
    // Search may fail; thread still has root + self-thread
  }

  return result;
}

/**
 * Get recent tweets from a specific user.
 */
export async function profile(
  username: string,
  opts: { count?: number; includeReplies?: boolean } = {}
): Promise<{ user: any; tweets: Tweet[] }> {
  const scraper = await getScraper();
  const count = opts.count || 20;

  const prof = await scraper.getProfile(username);
  if (!prof) {
    throw new Error(`User @${username} not found`);
  }

  const user = {
    id: prof.userId,
    username: prof.username,
    name: prof.name,
    description: prof.biography,
    created_at: prof.joined
      ? new Date(prof.joined).toISOString()
      : undefined,
    public_metrics: {
      followers_count: prof.followersCount ?? 0,
      following_count: prof.followingCount ?? 0,
      tweet_count: prof.tweetsCount ?? 0,
      listed_count: prof.listedCount ?? 0,
    },
  };

  const tweets: Tweet[] = [];
  const generator = opts.includeReplies
    ? scraper.getTweetsAndReplies(username, count)
    : scraper.getTweets(username, count);

  for await (const raw of generator) {
    if (raw.isRetweet) continue;
    const t = mapTweet(raw);
    if (t) tweets.push(t);
    if (tweets.length >= count) break;
  }

  return { user, tweets };
}

/**
 * Fetch a single tweet by ID.
 */
export async function getTweet(tweetId: string): Promise<Tweet | null> {
  const scraper = await getScraper();
  const raw = await scraper.getTweet(tweetId);
  return raw ? mapTweet(raw) : null;
}

/**
 * Sort tweets by engagement metric.
 */
export function sortBy(
  tweets: Tweet[],
  metric: "likes" | "impressions" | "retweets" | "replies" = "likes"
): Tweet[] {
  return [...tweets].sort((a, b) => b.metrics[metric] - a.metrics[metric]);
}

/**
 * Filter tweets by minimum engagement.
 */
export function filterEngagement(
  tweets: Tweet[],
  opts: { minLikes?: number; minImpressions?: number }
): Tweet[] {
  return tweets.filter((t) => {
    if (opts.minLikes && t.metrics.likes < opts.minLikes) return false;
    if (opts.minImpressions && t.metrics.impressions < opts.minImpressions)
      return false;
    return true;
  });
}

/**
 * Deduplicate tweets by ID.
 */
export function dedupe(tweets: Tweet[]): Tweet[] {
  const seen = new Set<string>();
  return tweets.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
