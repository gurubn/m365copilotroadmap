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
  if (s.includes("launch") || s.includes("general") || s.includes("available")) return "Launched";
  if (s.includes("rolling")) return "Rolling out";
  if (s.includes("develop") || s.includes("preview") || s.includes("soon")) return "In development";
  return raw || "Unknown";
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
  const items = all
    .filter(isCopilot)
    .map((item) => ({
      id: String(pick(item, "id") ?? ""),
      title: pick(item, "title") || "Untitled",
      description: (pick(item, "description") || "").replace(/<[^>]+>/g, "").trim(),
      status: normalizeStatus(pick(item, "status") || ""),
      created: pick(item, "created") || null,
      modified: pick(item, "modified") || null,
      ga: pick(item, "publicDisclosureAvailabilityDate", "gaDate") || null,
      products: productTags(item),
      link: `https://www.microsoft.com/microsoft-365/roadmap?id=${pick(item, "id")}`,
    }))
    // newest activity first
    .sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
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
const payload = {
  updated: new Date().toISOString(),
  counts: {
    total: items.length,
    inDevelopment: items.filter((i) => i.status === "In development").length,
    rollingOut: items.filter((i) => i.status === "Rolling out").length,
    launched: items.filter((i) => i.status === "Launched").length,
  },
  items,
  news,
};

await mkdir("data", { recursive: true });
await writeFile("data/roadmap.json", JSON.stringify(payload, null, 2));
console.log(`Wrote ${items.length} Copilot roadmap items, ${news.length} news posts.`);
