import fetch, { type RequestInit } from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import { readFile } from "node:fs/promises";
import { writeFileSync, appendFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import { validateBlock, getBlocksToValidate } from "./schema-rules.js";

const REPORT_PATH = "schema-report.html";

/** Request as a browser so servers return full HTML including JSON-LD (many strip it for non-browser User-Agents). */
const FETCH_OPTIONS: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
};

export interface BlockResult {
  blockIndex: number;
  status: "valid" | "warnings" | "errors";
  types: string[];
  errors: string[];
  warnings: string[];
}

export interface PageResult {
  url: string;
  fetchError?: string;
  blocks: BlockResult[];
}

const getUrlsFromSitemap = async (baseUrl: string): Promise<string[]> => {
  const sitemapUrl = `${baseUrl.replace(/\/$/, "")}/sitemap.xml`;
  try {
    const response = await fetch(sitemapUrl, FETCH_OPTIONS);
    const xml = await response.text();
    const parser = new XMLParser();
    const json = parser.parse(xml) as {
      urlset?: { url?: { loc: string } | { loc: string }[] };
    };
    const raw = json?.urlset?.url;
    const urls = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return urls.map((u) => u.loc.replace(/^https?:\/\/[^/]+/, baseUrl));
  } catch (err) {
    console.error(
      "Failed to fetch sitemap:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
};

const isValidUrl = (s: string): boolean => {
  const t = s.trim();
  return t.startsWith("http://") || t.startsWith("https://");
};

const getUrlsFromCsv = async (filePath: string): Promise<string[]> => {
  const content = await readFile(filePath, "utf-8");
  const rows = parseCsv(content, {
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as string[][];
  if (rows.length === 0) return [];
  const urls: string[] = [];
  let urlColumnIndex = 0;
  let dataStart = 0;
  const first = rows[0];
  const firstCell = (first[0] ?? "").trim();
  if (isValidUrl(firstCell)) {
    dataStart = 0;
    urlColumnIndex = 0;
  } else {
    const urlIdx = first.findIndex(
      (cell) => (cell ?? "").trim().toLowerCase() === "url",
    );
    urlColumnIndex = urlIdx >= 0 ? urlIdx : 0;
    dataStart = 1;
  }
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const cell = (row[urlColumnIndex] ?? "").trim();
    if (!cell) continue;
    if (isValidUrl(cell)) {
      urls.push(cell);
    } else {
      console.error(
        `Skipping invalid URL in CSV row ${i + 1}: ${cell.slice(0, 80)}${cell.length > 80 ? "..." : ""}`,
      );
    }
  }
  return urls;
};

const LD_JSON_TYPE = "application/ld+json";

const extractJsonLd = (
  html: string,
): { json?: Record<string, unknown>; error?: string; detail?: string }[] => {
  const $ = cheerio.load(html);
  const results: {
    json?: Record<string, unknown>;
    error?: string;
    detail?: string;
  }[] = [];
  $("script").each((_, el) => {
    const type = ($(el).attr("type") ?? "").trim().toLowerCase();
    if (!type.includes(LD_JSON_TYPE)) return;
    try {
      const text = $(el).html()?.trim();
      const json = text
        ? (JSON.parse(text) as Record<string, unknown>)
        : undefined;
      results.push(
        json !== undefined
          ? { json }
          : { error: "Empty block", detail: "No JSON content" },
      );
    } catch (e) {
      results.push({
        error: "Invalid JSON",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
  return results;
};

const getTypesFromBlock = (block: Record<string, unknown>): string[] => {
  const t = block["@type"];
  if (typeof t === "string") return [t.replace(/^schema:/, "")];
  if (Array.isArray(t))
    return t
      .map((x) => (typeof x === "string" ? x.replace(/^schema:/, "") : ""))
      .filter(Boolean);
  return [];
};

const validateOneBlock = (
  blockIndex: number,
  parsed: Record<string, unknown>,
  strict: boolean,
): BlockResult => {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];
  const allTypes: string[] = [];
  const nodes = getBlocksToValidate(parsed);
  for (const node of nodes) {
    allTypes.push(...getTypesFromBlock(node));
    const messages = validateBlock(node, { strict });
    for (const m of messages) {
      if (m.kind === "error") allErrors.push(m.message);
      else allWarnings.push(m.message);
    }
  }
  const types = [...new Set(allTypes)];
  const status: BlockResult["status"] =
    allErrors.length > 0
      ? "errors"
      : allWarnings.length > 0
        ? "warnings"
        : "valid";
  return {
    blockIndex,
    status,
    types,
    errors: allErrors,
    warnings: allWarnings,
  };
};

type FetchHtml = (url: string) => Promise<string>;

interface PageLike {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
  pdf?(options: {
    path?: string;
    format?: string;
    printBackground?: boolean;
    margin?: { top?: string; bottom?: string; left?: string; right?: string };
    scale?: number;
  }): Promise<Buffer>;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

const fetchWithBrowser = async (
  browser: BrowserLike,
  url: string,
  waitMs: number,
): Promise<string> => {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, waitMs));
    return await page.content();
  } finally {
    await page.close();
  }
};

const validatePage = async (
  url: string,
  fetchHtml: FetchHtml,
  strict: boolean,
): Promise<PageResult> => {
  try {
    const html = await fetchHtml(url);
    const rawBlocks = extractJsonLd(html);
    const blocks: BlockResult[] = [];
    rawBlocks.forEach((item, index) => {
      if (item.error) {
        blocks.push({
          blockIndex: index + 1,
          status: "errors",
          types: [],
          errors: [item.detail ?? item.error],
          warnings: [],
        });
      } else if (item.json) {
        blocks.push(validateOneBlock(index + 1, item.json, strict));
      }
    });
    return { url, blocks };
  } catch (err) {
    return {
      url,
      fetchError: err instanceof Error ? err.message : String(err),
      blocks: [],
    };
  }
};

const writeHtmlReport = (results: PageResult[], outputPath: string): void => {
  const totalPages = results.length;
  const totalBlocks = results.reduce((sum, p) => sum + p.blocks.length, 0);
  let validCount = 0;
  let warningsCount = 0;
  let errorsCount = 0;
  let fetchFailedCount = 0;
  let noLdCount = 0;
  const typeSet = new Set<string>();
  const rows: string[] = [];

  results.forEach((page) => {
    if (page.fetchError) fetchFailedCount++;
    else if (page.blocks.length === 0) noLdCount++;
    page.blocks.forEach((b) => {
      if (b.status === "valid") validCount++;
      else if (b.status === "warnings") warningsCount++;
      else errorsCount++;
      for (const t of b.types) typeSet.add(t);
      const status = page.fetchError ? "fetch_failed" : b.status;
      const typesStr = b.types.length ? b.types.join(", ") : "—";
      const details = [...b.errors, ...b.warnings];
      const detailsHtml = details.length
        ? `<ul class="details">${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
        : "";
      rows.push(
        `<tr data-status="${status}" data-type="${escapeHtml(typesStr)}" data-url="${escapeHtml(page.url)}">
          <td><a href="${escapeHtml(page.url)}" target="_blank" rel="noopener">${escapeHtml(page.url)}</a></td>
          <td><span class="badge badge-${status}">${status}</span></td>
          <td>${escapeHtml(typesStr)}</td>
          <td>${b.blockIndex}</td>
          <td>${page.fetchError ? escapeHtml(page.fetchError) : detailsHtml}</td>
        </tr>`,
      );
    });
    if (page.fetchError && page.blocks.length === 0) {
      rows.push(
        `<tr data-status="fetch_failed" data-type="—" data-url="${escapeHtml(page.url)}">
          <td><a href="${escapeHtml(page.url)}" target="_blank" rel="noopener">${escapeHtml(page.url)}</a></td>
          <td><span class="badge badge-fetch_failed">fetch failed</span></td>
          <td>—</td>
          <td>—</td>
          <td>${escapeHtml(page.fetchError)}</td>
        </tr>`,
      );
    } else if (!page.fetchError && page.blocks.length === 0) {
      rows.push(
        `<tr data-status="no_ld" data-type="—" data-url="${escapeHtml(page.url)}">
          <td><a href="${escapeHtml(page.url)}" target="_blank" rel="noopener">${escapeHtml(page.url)}</a></td>
          <td><span class="badge badge-no_ld">no JSON-LD</span></td>
          <td>—</td>
          <td>—</td>
          <td>No JSON-LD found on page</td>
        </tr>`,
      );
    }
  });

  const typesOptions = [...typeSet]
    .sort()
    .map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
    .join("");

  const PAGE_SIZE = 15;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Schema.org validation report</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem 2rem; }
    h1 { margin-bottom: 0.5rem; }
    .summary { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0; }
    .summary span { padding: 0.25rem 0.5rem; border-radius: 4px; }
    .filters { margin: 1rem 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .filters label { font-weight: 500; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #f5f5f5; }
    .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.85em; }
    .badge-valid { background: #d4edda; color: #155724; }
    .badge-warnings { background: #fff3cd; color: #856404; }
    .badge-errors { background: #f8d7da; color: #721c24; }
    .badge-fetch_failed { background: #e2e3e5; color: #383d41; }
    .badge-no_ld { background: #e7e7e7; color: #555; }
    .details { margin: 0; padding-left: 1.25rem; font-size: 0.9em; }
    .hidden { display: none; }
    .page-hidden { display: none; }
    .pagination { margin: 1rem 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
    .pagination button { padding: 0.25rem 0.75rem; cursor: pointer; }
    .pagination button:disabled { cursor: default; opacity: 0.6; }
    a { color: #0066cc; }
    @media print {
      .filters, .pagination { display: none !important; }
      tr.hidden, tr.page-hidden { display: table-row !important; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
      body { margin: 0.5rem; }
    }
  </style>
</head>
<body>
  <h1>Schema.org validation report</h1>
  <div class="summary">
    <span>Pages: ${totalPages}</span>
    <span>Blocks: ${totalBlocks}</span>
    <span class="badge badge-valid">Valid: ${validCount}</span>
    <span class="badge badge-warnings">Warnings: ${warningsCount}</span>
    <span class="badge badge-errors">Errors: ${errorsCount}</span>
    <span class="badge badge-fetch_failed">Fetch failed: ${fetchFailedCount}</span>
    <span class="badge badge-no_ld">No JSON-LD: ${noLdCount}</span>
  </div>
  <div class="filters">
    <label>Status:</label>
    <select id="filterStatus">
      <option value="">All</option>
      <option value="valid">Valid</option>
      <option value="warnings">Warnings</option>
      <option value="errors">Errors</option>
      <option value="fetch_failed">Fetch failed</option>
      <option value="no_ld">No JSON-LD</option>
    </select>
    <label>@type:</label>
    <select id="filterType">
      <option value="">All</option>
      ${typesOptions}
    </select>
    <label>URL contains:</label>
    <input type="text" id="filterUrl" placeholder="Filter by URL">
    <button type="button" id="resetFilters">Reset</button>
  </div>
  <div id="pagination" class="pagination">
    <span id="paginationSummary">—</span>
    <button type="button" id="prevPage">Prev</button>
    <button type="button" id="nextPage">Next</button>
  </div>
  <table>
    <thead>
      <tr>
        <th>URL</th>
        <th>Status</th>
        <th>@type</th>
        <th>Block</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join("")}
    </tbody>
  </table>
  <script>
    (function() {
      var PAGE_SIZE = ${PAGE_SIZE};
      var currentPage = 0;
      var totalPages = 1;
      var rows = document.querySelectorAll('tbody tr');
      var filterStatus = document.getElementById('filterStatus');
      var filterType = document.getElementById('filterType');
      var filterUrl = document.getElementById('filterUrl');
      var reset = document.getElementById('resetFilters');
      var paginationSummary = document.getElementById('paginationSummary');
      var prevBtn = document.getElementById('prevPage');
      var nextBtn = document.getElementById('nextPage');
      function apply() {
        var status = (filterStatus && filterStatus.value) || '';
        var type = (filterType && filterType.value) || '';
        var url = (filterUrl && filterUrl.value.trim()) || '';
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var show = true;
          if (status && row.getAttribute('data-status') !== status) show = false;
          if (show && type && row.getAttribute('data-type').indexOf(type) === -1) show = false;
          if (show && url && row.getAttribute('data-url').indexOf(url) === -1) show = false;
          row.classList.toggle('hidden', !show);
        }
        var visibleRows = [];
        for (var j = 0; j < rows.length; j++) {
          if (!rows[j].classList.contains('hidden')) visibleRows.push(rows[j]);
        }
        var totalVisible = visibleRows.length;
        totalPages = totalVisible === 0 ? 1 : Math.ceil(totalVisible / PAGE_SIZE);
        if (currentPage >= totalPages) currentPage = totalPages - 1;
        if (currentPage < 0) currentPage = 0;
        for (var k = 0; k < visibleRows.length; k++) {
          var onPage = k >= currentPage * PAGE_SIZE && k < currentPage * PAGE_SIZE + PAGE_SIZE;
          visibleRows[k].classList.toggle('page-hidden', !onPage);
        }
        if (paginationSummary) {
          if (totalVisible === 0) {
            paginationSummary.textContent = 'No rows';
          } else {
            var from = currentPage * PAGE_SIZE + 1;
            var to = Math.min(currentPage * PAGE_SIZE + PAGE_SIZE, totalVisible);
            paginationSummary.textContent = 'Showing ' + from + '\u2013' + to + ' of ' + totalVisible;
          }
        }
        if (prevBtn) prevBtn.disabled = currentPage <= 0;
        if (nextBtn) nextBtn.disabled = currentPage >= totalPages - 1;
      }
      function applyFiltersAndResetPage() {
        currentPage = 0;
        apply();
      }
      if (filterStatus) filterStatus.addEventListener('change', applyFiltersAndResetPage);
      if (filterType) filterType.addEventListener('change', applyFiltersAndResetPage);
      if (filterUrl) filterUrl.addEventListener('input', applyFiltersAndResetPage);
      if (reset) reset.addEventListener('click', function() {
        if (filterStatus) filterStatus.value = '';
        if (filterType) filterType.value = '';
        if (filterUrl) filterUrl.value = '';
        applyFiltersAndResetPage();
      });
      if (prevBtn) prevBtn.addEventListener('click', function() {
        if (currentPage > 0) { currentPage--; apply(); }
      });
      if (nextBtn) nextBtn.addEventListener('click', function() {
        if (currentPage < totalPages - 1) { currentPage++; apply(); }
      });
      apply();
    })();
  </script>
</body>
</html>`;

  writeFileSync(outputPath, html, "utf-8");
};

const PDF_REPORT_PATH = "schema-report.pdf";

const writePdfReport = async (
  htmlPath: string,
  pdfPath: string,
): Promise<void> => {
  let playwright: { chromium: { launch: () => Promise<BrowserLike> } };
  try {
    playwright = await import("playwright");
  } catch {
    console.error("PDF export requires Playwright. Run: bun add -d playwright");
    process.exit(1);
  }

  let browser: BrowserLike | null = null;
  try {
    browser = await playwright.chromium.launch();
    const page = await browser.newPage();
    const absolutePath = new URL(htmlPath, `file://${process.cwd()}/`).href;
    await page.goto(absolutePath, { waitUntil: "networkidle" });

    if (page.pdf) {
      await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
        scale: 0.8,
      });
    }

    await page.close();
  } finally {
    if (browser) await browser.close();
  }
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const DEFAULT_WAIT_MS = 2000;

const parseLimit = (): number | undefined => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-l" || arg === "--limit") {
      const next = argv[i + 1];
      const n = next ? parseInt(next, 10) : NaN;
      if (!Number.isNaN(n) && n > 0) return n;
    }
    if (
      (arg.startsWith("-l=") || arg.startsWith("--limit=")) &&
      arg.length > 8
    ) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!Number.isNaN(n) && n > 0) return n;
    }
  }
  return undefined;
};

const parseBrowser = (): boolean => {
  const argv = process.argv.slice(2);
  return argv.some((arg) => arg === "-b" || arg === "--browser");
};

const parseWait = (): number => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wait" && argv[i + 1] != null) {
      const n = parseInt(argv[i + 1], 10);
      if (!Number.isNaN(n) && n >= 0) return n;
    }
    if (arg.startsWith("--wait=")) {
      const n = parseInt(arg.slice(7), 10);
      if (!Number.isNaN(n) && n >= 0) return n;
    }
  }
  return DEFAULT_WAIT_MS;
};

const DEFAULT_BASE_URL = "http://localhost:8000";

const parseBaseUrl = (): string => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1] != null) {
      const u = argv[i + 1].replace(/\/$/, "");
      if (u.startsWith("http://") || u.startsWith("https://")) return u;
    }
    if (arg.startsWith("--url=")) {
      const u = arg.slice(6).replace(/\/$/, "");
      if (u.startsWith("http://") || u.startsWith("https://")) return u;
    }
    if (arg === "--port" && argv[i + 1] != null) {
      const p = parseInt(argv[i + 1], 10);
      if (!Number.isNaN(p) && p > 0) return `http://localhost:${p}`;
    }
    if (arg.startsWith("--port=")) {
      const p = parseInt(arg.slice(7), 10);
      if (!Number.isNaN(p) && p > 0) return `http://localhost:${p}`;
    }
  }
  return DEFAULT_BASE_URL;
};

const parseStrict = (): boolean => {
  return process.argv.slice(2).some((arg) => arg === "--strict");
};

const parsePdf = (): boolean => {
  return process.argv.slice(2).some((arg) => arg === "--pdf");
};

const parseCsvPath = (): string | undefined => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--csv" && argv[i + 1] != null) return argv[i + 1];
    if (arg.startsWith("--csv=") && arg.length > 6) return arg.slice(6);
  }
  return undefined;
};

const parseCi = (): boolean => {
  return process.argv.slice(2).some((arg) => arg === "--ci");
};

const isHomepage = (url: string): boolean => {
  try {
    const p = new URL(url).pathname;
    return p === "/" || p === "";
  } catch {
    return false;
  }
};

const run = async (): Promise<void> => {
  const limit = parseLimit();
  const useBrowser = parseBrowser();
  const waitMs = parseWait();
  const ciMode = parseCi();
  let browser: BrowserLike | null = null;

  if (useBrowser) {
    let playwright: { chromium: { launch: () => Promise<BrowserLike> } };
    try {
      playwright = await import("playwright");
    } catch {
      console.error(
        "Browser mode requires Playwright. Run: bun add -d playwright.",
      );
      process.exit(1);
    }
    try {
      browser = await playwright.chromium.launch();
      console.log(`Browser mode: waiting ${waitMs}ms after each page load.\n`);
    } catch (e) {
      console.error(
        "Failed to launch browser. If Playwright was just installed, run: bunx playwright install",
      );
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  const fetchHtml: FetchHtml = browser
    ? ((b) => (url: string) => fetchWithBrowser(b, url, waitMs))(browser)
    : (url) => fetch(url, FETCH_OPTIONS).then((res) => res.text());

  const baseUrl = parseBaseUrl();
  const strict = parseStrict();
  const csvPath = parseCsvPath();
  if (strict) {
    console.log(
      "Strict mode: warnings for unknown types/properties and missing recommended.\n",
    );
  }
  let urls: string[];
  if (csvPath) {
    urls = await getUrlsFromCsv(csvPath);
    if (urls.length === 0) {
      console.log("No valid URLs found in CSV.");
      if (browser) await browser.close();
      return;
    }
  } else {
    urls = await getUrlsFromSitemap(baseUrl);
    if (urls.length === 0) {
      console.log("No URLs found in sitemap (or sitemap unreachable).");
      if (browser) await browser.close();
      return;
    }
    urls = [...urls].sort((a, b) => {
      const aHome = isHomepage(a);
      const bHome = isHomepage(b);
      if (aHome && !bHome) return -1;
      if (!aHome && bHome) return 1;
      return 0;
    });
  }
  if (limit !== undefined) {
    urls = urls.slice(0, limit);
    console.log(`Limiting to first ${limit} URL(s).\n`);
  }
  const results: PageResult[] = [];
  try {
    for (const url of urls) {
      console.log(`\nValidating: ${url}`);
      const pageResult = await validatePage(url, fetchHtml, strict);
      results.push(pageResult);
      if (pageResult.fetchError) {
        console.log(`Failed to fetch ${url}`);
        console.log(pageResult.fetchError);
        continue;
      }
      if (pageResult.blocks.length === 0) {
        console.log("No JSON-LD found");
        continue;
      }
      pageResult.blocks.forEach((b) => {
        if (b.status === "valid") {
          console.log(`  Block ${b.blockIndex}: Valid`);
        } else if (b.status === "warnings") {
          console.log(`  Block ${b.blockIndex}: Warnings`);
          for (const w of b.warnings) console.log(`    - ${w}`);
        } else {
          console.log(`  Block ${b.blockIndex}: Errors`);
          for (const e of b.errors) console.log(`    - ${e}`);
          for (const w of b.warnings) console.log(`    - ${w}`);
        }
      });
    }
  } finally {
    if (browser) await browser.close();
  }

  if (ciMode) {
    let validCount = 0;
    let warningsCount = 0;
    let errorsCount = 0;
    let fetchFailedCount = 0;
    let noLdCount = 0;
    const errorDetails: { url: string; message: string }[] = [];

    for (const page of results) {
      if (page.fetchError) {
        fetchFailedCount++;
        errorDetails.push({
          url: page.url,
          message: `Fetch failed: ${page.fetchError}`,
        });
      } else if (page.blocks.length === 0) {
        noLdCount++;
      }
      for (const block of page.blocks) {
        if (block.status === "valid") validCount++;
        else if (block.status === "warnings") warningsCount++;
        else {
          errorsCount++;
          for (const err of block.errors) {
            errorDetails.push({ url: page.url, message: err });
          }
        }
      }
    }

    console.log("\n--- Schema Validation Summary ---");
    console.log(`Pages checked: ${results.length}`);
    console.log(`Valid blocks:  ${validCount}`);
    console.log(`Warnings:      ${warningsCount}`);
    console.log(`Errors:        ${errorsCount}`);
    console.log(`Fetch failed:  ${fetchFailedCount}`);
    console.log(`No JSON-LD:    ${noLdCount}`);

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      const passed = errorsCount === 0 && fetchFailedCount === 0;
      const statusIcon = passed ? "✅" : "❌";

      let markdown = `## ${statusIcon} Schema Validation Results\n\n`;
      markdown += `| Metric | Count |\n`;
      markdown += `|--------|-------|\n`;
      markdown += `| Pages checked | ${results.length} |\n`;
      markdown += `| Valid blocks | ${validCount} |\n`;
      markdown += `| Warnings | ${warningsCount} |\n`;
      markdown += `| Errors | ${errorsCount} |\n`;
      markdown += `| Fetch failed | ${fetchFailedCount} |\n`;
      markdown += `| No JSON-LD | ${noLdCount} |\n\n`;

      if (errorDetails.length > 0) {
        markdown += `### Failed Validations\n\n`;
        for (const detail of errorDetails) {
          markdown += `- **${detail.url}**\n  - ${detail.message}\n`;
        }
      }

      appendFileSync(summaryPath, markdown);
    }

    if (errorsCount > 0 || fetchFailedCount > 0) {
      console.log("\nFailed validations:");
      for (const detail of errorDetails) {
        console.log(`  ${detail.url}`);
        console.log(`    → ${detail.message}`);
      }
      console.log("\nSchema validation failed.");
      process.exit(1);
    }

    console.log("\nAll schema validations passed!");
    process.exit(0);
  }

  writeHtmlReport(results, REPORT_PATH);
  console.log(`\nReport written to ${REPORT_PATH}`);

  const exportPdf = parsePdf();
  if (exportPdf) {
    console.log("Generating PDF...");
    await writePdfReport(REPORT_PATH, PDF_REPORT_PATH);
    console.log(`PDF report written to ${PDF_REPORT_PATH}`);
  }
};

run();
