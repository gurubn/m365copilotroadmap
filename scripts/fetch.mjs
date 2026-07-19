// Fetches Microsoft 365 Copilot roadmap data + TechCommunity "What's New" posts
// and writes data/roadmap.json. No npm dependencies — uses Node 20+ global fetch.
// Runs in GitHub Actions on a weekly schedule (see .github/workflows/update.yml).

import { writeFile, mkdir } from "node:fs/promises";

const ROADMAP_API = "https://www.microsoft.com/releasecommunications/api/v1/m365";
// TechCommunity "Microsoft 365 Copilot Blog" board RSS.
// If the feed URL changes, only this line needs updating; the build degrades
// gracefully (empty news list) rather than failing. Note: this board feed
// only ever returns the latest ~20 posts (no pagination param works), which
// in practice covers roughly 2-3 months of posting cadence.
const TECHCOMMUNITY_RSS =
  "https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=Microsoft365CopilotBlog";
const NEWS_MONTHS = 3;

// Specific product/app names to detect inside TechCommunity post text, so
// posts can be tagged with the same product names used on roadmap items and
// then cross-linked. Deliberately excludes generic tags like "Microsoft 365
// Copilot" — matching on those would link almost every post to almost every
// item, which isn't useful.
const PRODUCT_KEYWORDS = {
  Word: [/\bword\b/i],
  Excel: [/\bexcel\b/i],
  PowerPoint: [/\bpowerpoint\b/i],
  "Microsoft Teams": [/\bteams\b/i],
  Outlook: [/\boutlook\b/i],
  SharePoint: [/\bsharepoint\b/i],
  OneDrive: [/\bonedrive\b/i],
  OneNote: [/\bonenote\b/i],
  "Microsoft Viva": [/\bviva\b/i],
  "Microsoft Purview": [/\bpurview\b/i],
  Planner: [/\bplanner\b/i],
  "Microsoft Copilot Studio": [/\bcopilot studio\b/i],
  "Microsoft Edge": [/\bedge\b/i],
  "Microsoft 365 admin center": [/\badmin center\b/i],
  "Microsoft Entra": [/\bentra\b/i],
  "Microsoft Clipchamp": [/\bclipchamp\b/i],
  Forms: [/\bmicrosoft forms\b/i],
  "Power Automate": [/\bpower automate\b/i],
};

function detectProducts(text) {
  return Object.entries(PRODUCT_KEYWORDS)
    .filter(([, patterns]) => patterns.some((re) => re.test(text)))
    .map(([name]) => name);
}

// Security & compliance classifier, shared by roadmap items (title only) and
// TechCommunity posts (title only) — deliberately title-only to avoid the
// generic "security, compliance, and privacy" marketing boilerplate that
// shows up in most Copilot post bodies, which would otherwise match nearly
// everything.
const SECURITY_RE =
  /\b(security|compliance|purview|entra|defender|dlp|data loss prevention|sensitivity label|e-?discovery|insider risk|conditional access|information barrier|retention|audit log|encryption)\b/i;

function isSecurityCompliance(title, products = []) {
  return (
    products.includes("Microsoft Purview") ||
    products.includes("Microsoft Entra") ||
    SECURITY_RE.test(title || "")
  );
}

// Case-insensitive field getter — the API has mixed casing across fields.
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(obj || {}).find((o) => o.toLowerCase() === k.toLowerCase());
    if (hit && obj[hit] != null) return obj[hit];
  }
  return undefined;
};

function isCopilot(item) {
  const hay = [
    pick(item, "title") || "",
    pick(item, "description") || "",
    JSON.stringify(pick(item, "tags") || []),
    JSON.stringify(pick(item, "tagsContainer") || {}),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes("copilot");
}

function normalizeStatus(raw = "") {
  const s = raw.toLowerCase();
  if (s.includes("cancel")) return "Cancelled";
  if (s.includes("launch") || s.includes("general") || s.includes("available")) return "Launched";
  if (s.includes("rolling")) return "Rolling out";
  if (s.includes("develop") || s.includes("preview") || s.includes("soon")) return "In development";
  return raw || "Unknown";
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// The roadmap API stores availability as free text, e.g. "August CY2026",
// "Q1 CY2026", or just "CY2026". Parse it to a concrete Date (first of the
// month/quarter/year) so items can be placed on a timeline. Returns null when
// unparseable.
function parseGADate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/([A-Za-z]+)\s+CY(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()] != null) {
    return new Date(Date.UTC(+m[2], MONTHS[m[1].toLowerCase()], 1));
  }
  m = s.match(/Q([1-4])\s+CY(\d{4})/i);
  if (m) return new Date(Date.UTC(+m[2], (+m[1] - 1) * 3, 1));
  m = s.match(/CY(\d{4})/);
  if (m) return new Date(Date.UTC(+m[1], 0, 1));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// The date used to place an item on the ±6-month timeline: prefer the parsed
// availability (GA) date, then last-modified, then created.
function timelineDate(item) {
  return (
    parseGADate(item.ga) ||
    (item.modified ? new Date(item.modified) : null) ||
    (item.created ? new Date(item.created) : null)
  );
}

function productTags(item) {
  const tc = pick(item, "tagsContainer") || {};
  const products = pick(tc, "products") || [];
  return products
    .map((p) => pick(p, "tagName", "name"))
    .filter(Boolean);
}

async function fetchRoadmap() {
  const res = await fetch(ROADMAP_API, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Roadmap API ${res.status}`);
  const all = await res.json();

  // ±6-month window around today: previous 6 months through next 6 months.
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setMonth(windowStart.getMonth() - 6);
  const windowEnd = new Date(now);
  windowEnd.setMonth(windowEnd.getMonth() + 6);

  const items = all
    .filter(isCopilot)
    .map((item) => {
      const ga = pick(item, "publicDisclosureAvailabilityDate", "gaDate") || null;
      const created = pick(item, "created") || null;
      const modified = pick(item, "modified") || null;
      const gaDate = parseGADate(ga);
      const title = pick(item, "title") || "Untitled";
      const products = productTags(item);
      return {
        id: String(pick(item, "id") ?? ""),
        title,
        description: (pick(item, "description") || "").replace(/<[^>]+>/g, "").trim(),
        status: normalizeStatus(pick(item, "status") || ""),
        created,
        modified,
        ga,
        // ISO form of the parsed availability date, for timeline placement.
        gaDate: gaDate ? gaDate.toISOString() : null,
        products,
        securityCompliance: isSecurityCompliance(title, products),
        // Filled in below once TechCommunity posts are fetched.
        newsLink: null,
        newsTitle: null,
        link: `https://www.microsoft.com/microsoft-365/roadmap?id=${pick(item, "id")}`,
      };
    })
    // Keep only items whose timeline date falls in the ±6-month window.
    .filter((item) => {
      const d = timelineDate(item);
      return d && d >= windowStart && d <= windowEnd;
    })
    // Chronological by availability date (falls back to modified/created).
    .sort((a, b) => timelineDate(a) - timelineDate(b));
  return items;
}

async function fetchNews() {
  try {
    const res = await fetch(TECHCOMMUNITY_RSS, { headers: { Accept: "application/rss+xml,text/xml" } });
    if (!res.ok) throw new Error(`RSS ${res.status}`);
    const xml = await res.text();

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - NEWS_MONTHS);

    const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/g)]
      .map((m) => {
        const block = m[0];
        const grab = (tag) => {
          const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
          return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
        };
        const title = grab("title");
        const description = grab("description");
        const pubDate = grab("pubDate");
        const date = pubDate ? new Date(pubDate) : null;
        const products = detectProducts(`${title} ${description}`);
        return {
          title,
          link: grab("link"),
          date: date && !isNaN(date) ? date.toISOString() : null,
          products,
          securityCompliance: isSecurityCompliance(title, products),
        };
      })
      // Latest N months only.
      .filter((i) => i.title && i.date && new Date(i.date) >= cutoff)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    return items;
  } catch (e) {
    console.warn("TechCommunity feed unavailable, skipping news:", e.message);
    return [];
  }
}

// Cross-link roadmap items to TechCommunity posts that share a specific
// product tag (product-tag match, not keyword/title matching — coarser but
// more reliable). Broad monthly "What's New" roundup posts mention nearly
// every product and would otherwise match almost every item, so only posts
// focused on a handful of products are eligible to be linked. When multiple
// eligible posts match, the most recent one wins.
const MAX_PRODUCTS_FOR_LINKING = 3;

function linkNewsToItems(items, news) {
  const focused = news.filter((n) => n.products.length > 0 && n.products.length <= MAX_PRODUCTS_FOR_LINKING);
  for (const item of items) {
    if (!item.products.length) continue;
    const matches = focused.filter((n) => n.products.some((p) => item.products.includes(p)));
    if (!matches.length) continue;
    const best = matches.reduce((a, b) => (new Date(b.date) > new Date(a.date) ? b : a));
    item.newsLink = best.link;
    item.newsTitle = best.title;
  }
}

const [items, news] = await Promise.all([fetchRoadmap(), fetchNews()]);
linkNewsToItems(items, news);

const windowStart = new Date();
windowStart.setMonth(windowStart.getMonth() - 6);
const windowEnd = new Date();
windowEnd.setMonth(windowEnd.getMonth() + 6);
const newsWindowStart = new Date();
newsWindowStart.setMonth(newsWindowStart.getMonth() - NEWS_MONTHS);
const payload = {
  updated: new Date().toISOString(),
  window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
  newsWindow: { start: newsWindowStart.toISOString(), end: new Date().toISOString() },
  counts: {
    total: items.length,
    inDevelopment: items.filter((i) => i.status === "In development").length,
    rollingOut: items.filter((i) => i.status === "Rolling out").length,
    launched: items.filter((i) => i.status === "Launched").length,
    cancelled: items.filter((i) => i.status === "Cancelled").length,
    securityCompliance: items.filter((i) => i.securityCompliance).length,
  },
  items,
  news,
};

await mkdir("data", { recursive: true });
await writeFile("data/roadmap.json", JSON.stringify(payload, null, 2));
console.log(`Wrote ${items.length} Copilot roadmap items, ${news.length} news posts.`);
