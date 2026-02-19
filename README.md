# Local Schema.org Validator

Validates pages’ JSON-LD against Schema.org rules and writes a filterable HTML report. By default it discovers URLs from your sitemap at `localhost:8000`; you can instead supply a list of URLs via a CSV file.

## Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- Either: your site running at `http://localhost:8000` with `/sitemap.xml` available, or a CSV file of URLs (see **`--csv`** below)

## Install and run

```bash
bun install
bun run validate
```

**Options (pass after `--`):**

- **`--csv PATH`** — Read URLs from a CSV file instead of the sitemap. Use this to audit a fixed list of URLs. See **CSV format** below. Example: `bun run validate -- --csv urls.csv`.
- **`-l` / `--limit N`** — Validate only the first N URLs (e.g. `bun run validate -- -l 5`, `bun run validate -- --limit=10`).
- **`-b` / `--browser`** — Load each URL in a headless browser so JavaScript runs (e.g. React/Gatsby) and JSON-LD injected after load is included. Requires Playwright (`bun add -d playwright`). First time you use it, install browser binaries: `bunx playwright install`. Slower than the default fetch-only mode.
- **`--wait N`** — In browser mode, wait N milliseconds after each page load before capturing HTML (default: 2000). Example: `bun run validate -- --browser --wait 3000`.
- **`--url URL`** or **`--port N`** — Base URL to use for the sitemap and pages (default: `http://localhost:8000`). Ignored when using `--csv`. Use when your site runs on a different port, e.g. after `gatsby build && gatsby serve -p 9000`: `bun run validate -- --port 9000` or `bun run validate -- --url http://localhost:9000`.
- **`--strict`** — Enable strict mode: also report **warnings** for unknown Schema.org types, unknown properties, and missing recommended properties. By default the tool runs in **permissive** mode (only errors: missing required, wrong property types), so results align with [validator.schema.org](https://validator.schema.org) (0 warnings for valid vocabulary). Use `--strict` when you want best-practice guidance beyond the official validator.

**CSV format (for `--csv`):** One URL per row. You may use a header row: if the first row contains a column named `url` (case-insensitive), that column is used; otherwise the first column is used. Rows without a valid URL are skipped. Only values starting with `http://` or `https://` are accepted; invalid entries are logged to stderr.

Bun runs TypeScript natively; no build step. After the run, open **schema-report.html** in a browser to inspect and filter results.

## What is validated

- **JSON syntax** — each `application/ld+json` block is valid JSON.
- **Presence** — reports when a page has no JSON-LD.
- **Schema.org (always):** Missing `@type`, missing **required** properties, and wrong property types (e.g. `offers` must be Offer/AggregateOffer) → **Errors**.
- **Schema.org (strict mode only):** Missing **recommended** properties, unknown `@type`, and unknown properties → **Warnings**. In **permissive** mode (default) these are not reported, so the tool matches [validator.schema.org](https://validator.schema.org) behavior: valid vocabulary yields 0 errors and 0 warnings. Use `--strict` to get extra best-practice warnings.
- **Fetch errors** — failed requests are reported per URL.

## HTML report

- **Output:** `schema-report.html` in the project root (overwritten each run).
- **Summary:** Total pages, total blocks, counts for Valid / Warnings / Errors / Fetch failed / No JSON-LD.
- **Filters (in-page):** Status (All / Valid / Warnings / Errors / Fetch failed / No JSON-LD), @type (dropdown from data), and “URL contains” text. Use **Reset** to clear filters.
- Open the file in any browser; no server needed. Use it to quickly see which URLs or types are failing and which pass.

## React / Gatsby (SPAs)

By default the validator only reads the **initial HTTP response** and does not run JavaScript. So:

- **Production builds** (e.g. Gatsby’s static HTML) often include JSON-LD in the first response; the default mode is usually enough.
- **Development servers** or **client-injected JSON-LD** (e.g. React components that add `<script type="application/ld+json">` after mount) are not seen unless you use **browser mode**.

Use **`--browser`** so each URL is loaded in a headless browser, the page (and React) runs, and the validator then captures the rendered HTML including any JSON-LD injected by JavaScript:

```bash
bun run validate -- --browser
bun run validate -- --browser --wait 3000 -l 5
```

**Quick check:** On the same URL, use “View source” (not Inspect). If the JSON-LD script is in the source, the default mode should see it. If it only appears in the Inspect panel after load, it’s client-injected — use `--browser`.

## Strict vs permissive (validator.schema.org alignment)

By **default** the validator runs in **permissive** mode: it only reports **errors** (missing required, wrong types). It does *not* warn on unknown Schema.org types, unknown properties, or missing recommended properties. That way, markup that passes [validator.schema.org](https://validator.schema.org) with 0 errors and 0 warnings will also pass here with 0 errors and 0 warnings.

If you want the tool to be **stricter** than the official validator (e.g. to enforce recommended properties and a curated vocabulary), run with **`--strict`**. In strict mode you get **warnings** for unknown types, unknown properties, and missing recommended fields. Warnings in this tool do not imply invalidity on validator.schema.org.

## If every page shows “No JSON-LD”

- **Client-injected markup:** If your site (e.g. React/Gatsby in dev) adds JSON-LD via JavaScript, use **`--browser`** (see above).
- **Script type:** The validator looks for `<script type="application/ld+json">` and accepts any casing or surrounding whitespace. If your markup uses a different type string, it won’t be picked up.
- **User-Agent:** The validator sends a browser-like User-Agent so servers that strip JSON-LD for bots return the same HTML. If your server treats localhost differently, you may still see different content.
- **Wrong URL or HTML:** Confirm the sitemap URLs return 200 and the body is the page HTML. Use “View source” to confirm whether JSON-LD is in the initial response.

## Vocabulary and validator alignment

Known Schema.org types and properties are derived from the [official Schema.org JSON-LD context](https://schema.org/docs/jsonldcontext.json). Run `bun run build:vocab` to regenerate `schema-vocabulary.generated.ts` (e.g. after a Schema.org release). The [validator.schema.org](https://validator.schema.org) service does not publish its validation rules (required/recommended, error vs warning); our strict-mode rules for required/recommended and property types are curated from best practices, not synced from the validator.

## Configuration

- **Base URL / port:** Use `--url http://localhost:9000` or `--port 9000` so the validator fetches the sitemap and pages from that origin (e.g. a Gatsby production build served on port 9000).
- **Report path:** Edit `REPORT_PATH` at the top of **validate.ts** to change where the HTML report is written (default `schema-report.html`).

## GitHub Action

Use this validator as a GitHub Action to automatically validate JSON-LD on preview deployments. The action fails the build if schema errors are found.

### CI Mode

Run locally in CI mode (no HTML report, just pass/fail):

```bash
bun run validate -- --ci --csv urls.csv
```

### Basic Usage

```yaml
# .github/workflows/schema-check.yml
name: Schema Validation
on:
  deployment_status:

jobs:
  validate-schema:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: cgondrovic-servpro/schema-validator-action@v1
        with:
          preview-url: ${{ github.event.deployment_status.target_url }}
          paths: '/, /about, /products'
```

### Action Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `preview-url` | Yes | — | Preview deployment URL |
| `paths` | No | `/` | Comma-separated paths to validate |
| `browser` | No | `false` | Use browser mode for SPAs |
| `strict` | No | `false` | Enable strict validation |
| `wait` | No | `2000` | Wait time (ms) in browser mode |

### Vercel Example

```yaml
name: Schema Validation
on:
  deployment_status:

jobs:
  validate-schema:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: cgondrovic-servpro/schema-validator-action@v1
        with:
          preview-url: ${{ github.event.deployment_status.target_url }}
          paths: '/, /about, /products, /contact'
          browser: true
```

### Netlify Example

```yaml
name: Schema Validation
on:
  deployment_status:

jobs:
  validate-schema:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: cgondrovic-servpro/schema-validator-action@v1
        with:
          preview-url: ${{ github.event.deployment_status.target_url }}
          paths: '/, /about'
          strict: true
```

### Manual Trigger (for testing)

```yaml
name: Schema Validation (Manual)
on:
  workflow_dispatch:
    inputs:
      url:
        description: 'URL to validate'
        required: true

jobs:
  validate-schema:
    runs-on: ubuntu-latest
    steps:
      - uses: cgondrovic-servpro/schema-validator-action@v1
        with:
          preview-url: ${{ github.event.inputs.url }}
          paths: '/'
          browser: true
```

### How It Works

1. Preview deployment completes (Vercel, Netlify, etc.)
2. `deployment_status` event triggers the workflow
3. Action validates JSON-LD on each specified path
4. If errors found → `exit(1)` → workflow fails → PR blocked (with branch protection)
5. If all pass → `exit(0)` → green checkmark

## Development

### Scripts

| Command | Description |
|---------|-------------|
| `bun run validate` | Run schema validation |
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | Lint with Biome |
| `bun run lint:fix` | Auto-fix lint issues |
| `bun run format` | Format code with Biome |
| `bun run check` | Run typecheck + lint |

### Pre-commit Hooks

This project uses [Lefthook](https://github.com/evilmartians/lefthook) for pre-commit hooks. After `bun install`, hooks are automatically installed and will run `typecheck` and `lint` before each commit.

### Contributing

1. Fork the repo
2. Create a feature branch
3. Make changes (hooks will check your code)
4. Submit a PR
