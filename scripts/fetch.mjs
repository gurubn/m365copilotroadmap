// Fetches Microsoft 365 Copilot roadmap data + TechCommunity "What's New" posts
// and writes data/roadmap.json. No npm dependencies — uses Node 20+ global fetch.
// Runs in GitHub Actions on a weekly schedule (see .github/workflows/update.yml).

import { writeFile, mkdir } from "node:fs/promises";

const ROADMAP_API = "https://www.microsoft.com/releasecommunications/api/v1/m365";
// TechCommunity "What's New in Microsoft 365 Copilot" blog board RSS.
// If the feed URL changes, only this line needs updating; the build degrades
// gracefully (empty news list) rather than failing.
const TECHCOMMUNITY_RSS =
  "https://techcommunity.microsoft.com/category/microsoft365copilot/blog/microsoft365copilotblog/rss";

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
      return {
        id: String(pick(item, "id") ?? ""),
        title: pick(item, "title") || "Untitled",
        description: (pick(item, "description") || "").replace(/<[^>]+>/g, "").trim(),
        status: normalizeStatus(pick(item, "status") || ""),
        created,
        modified,
        ga,
        // ISO form of the parsed availability date, for timeline placement.
        gaDate: gaDate ? gaDate.toISOString() : null,
        products: productTags(item),
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
    const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/g)].slice(0, 12).map((m) => {
      const block = m[0];
      const grab = (tag) => {
        const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
        return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
      };
      return { title: grab("title"), link: grab("link"), date: grab("pubDate") };
    });
    return items.filter((i) => i.title);
  } catch (e) {
    console.warn("TechCommunity feed unavailable, skipping news:", e.message);
    return [];
  }
}

const [items, news] = await Promise.all([fetchRoadmap(), fetchNews()]);
const windowStart = new Date();
windowStart.setMonth(windowStart.getMonth() - 6);
const windowEnd = new Date();
windowEnd.setMonth(windowEnd.getMonth() + 6);
const payload = {
  updated: new Date().toISOString(),
  window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
  counts: {
    total: items.length,
    inDevelopment: items.filter((i) => i.status === "In development").length,
    rollingOut: items.filter((i) => i.status === "Rolling out").length,
    launched: items.filter((i) => i.status === "Launched").length,
    cancelled: items.filter((i) => i.status === "Cancelled").length,
  },
  items,
  news,
};

await mkdir("data", { recursive: true });
await writeFile("data/roadmap.json", JSON.stringify(payload, null, 2));
console.log(`Wrote ${items.length} Copilot roadmap items, ${news.length} news posts.`);
