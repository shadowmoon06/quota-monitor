# AGENTS.md

Guidance for coding agents working on **Pixel Quota Tree**, a VS Code extension that grows a pixel-art
tree from local AI coding agent token usage (Claude Code, Codex). See [README.md](README.md) for the
user-facing description.

## Commands

```sh
npm install
npm run compile     # tsc -> out/ ; must pass with zero errors before you finish
npm run watch
npm run package     # builds pixel-quota-tree-<version>.vsix via @vscode/vsce
node --check media/tree.js   # the webview script is plain JS and is NOT type-checked by tsc
```

Run/debug: F5 ("Run Extension" in `.vscode/launch.json`) opens an Extension Development Host. Then open
the **Quota Tree** activity-bar icon. There is no test suite yet; see "Verifying changes" below.

## Layout

| Path | Role |
|---|---|
| `src/extension.ts` | `activate()`: wires the service, webview view, status bar item, commands, config listener |
| `src/usageService.ts` | Polls providers, aggregates time windows (`5h`/`today`/`7d`/`30d`), applies Claude budgets, emits a `Snapshot` |
| `src/treeView.ts` | `WebviewViewProvider`: HTML shell with CSP and a nonce, message bridge |
| `src/providers/types.ts` | `UsageProvider`, `AgentUsage`, `TokenCounts`, `BUCKET_MS` (10 min), helpers |
| `src/providers/jsonlScanner.ts` | Incremental JSONL reader shared by the providers |
| `src/providers/claude.ts` | Claude Code: `<config>/projects/**/*.jsonl`, `message.usage` |
| `src/providers/codex.ts` | Codex: `<codex home>/sessions/**/*.jsonl`, `token_count` events and `rate_limits` |
| `media/tree.js` | Webview renderer: procedural pixel tree on a 128x160 canvas plus the HTML stats panel |
| `media/tree.css` | Panel styles; uses VS Code theme variables |
| `out/`, `*.vsix` | Build output. Never edit by hand |

Data flow: provider `collect()` → `UsageService.doRefresh()` → `Snapshot` → `postMessage({type:'update'})`
→ `onSnapshot()` in `tree.js`. Messages from webview to extension: `ready`, `refresh`, `setWindow`, `openSettings`.

## Invariants: don't break these

- **Read-only and local.** The extension only reads agent log files and makes no network calls. Never
  read credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`). Live plan quota via
  login tokens lives in the separate sibling project `../quota-left-tree`, not here.
- **Incremental parsing.** `JsonlScanner` keeps a byte offset per file, splits on the last `\n` *byte*
  (never on decoded strings, because UTF-8 can split across chunk boundaries) and leaves partial trailing lines
  for the next scan. A file that shrinks is reparsed from 0. Keep rescans cheap: they run every 30s
  over hundreds of files (~7 ms on a warm cache).
- **Use a `prefilter` string test before `JSON.parse`.** Most lines are irrelevant and some are huge.
- **Claude de-duplication:** streaming repeats assistant records, so dedupe on `message.id + requestId`
  per file. Skip `model === '<synthetic>'`.
- **Codex accounting:** `total_token_usage` is cumulative per session, so record *deltas*. If any
  field goes negative (counter reset), fall back to `last_token_usage`. `input_tokens` *includes*
  `cached_input_tokens`; `reasoning_output_tokens` is a subset of `output_tokens`. A rate-limit
  snapshot whose `resets_at` is in the past means 0% used.
- **Cache reads are excluded from totals by default** (`quotaTree.countCacheReads`). They are ~50x
  everything else and would swamp the visuals. Always go through `totalOf(counts, includeCacheReads)`.
- **Claude Code logs contain no plan limits.** Claude quota bars come only from the user's
  `quotaTree.claude.tokenBudget*` settings and must be labelled `source: 'budget'`.
- **Webview CSP:** `script-src 'nonce-…'`, `style-src ${cspSource}`. No inline `<script>`, no inline
  `style="..."` attributes in HTML strings, no external URLs. In `tree.js`, set styles via the `h()`
  helper's `style` object (CSSOM), which CSP allows.

## Visual mapping (keep semantics stable)

| Visual | Data |
|---|---|
| Trunk height, girth, branch depth | Lifetime tokens across agents, `growthOf()`: log10 scale, 10k → 0, ~3B → 1 |
| Bark stripes (left→right) | Each agent's share of lifetime tokens, in agent order |
| Leaves | Window tokens ÷ `tokensPerLeaf`; agents own contiguous crown regions in the same left→right order as the bark |
| Flashing leaves / falling leaves | New since last refresh / aged out of the window, or quota ≥ 80% |
| Fruit | Overflow when the canopy is full |

Renderer rules:
- **Pixel style is the product.** Draw only with integer 1px `fillRect` on the low-res canvas
  (`px()`), never with anti-aliased paths, gradients or `arc`. Scale with CSS
  `image-rendering: pixelated` at an **integer** factor (`fit()`). Keep `imageSmoothingEnabled = false`.
- **Determinism:** all randomness in tree and background generation comes from `rngFor(key)`
  (FNV hash → mulberry32), keyed by branch path. Shapes must not change between refreshes unless the
  data changes. Don't use `Math.random()` for structure; it's fine only for transient particles.
- The tree is rebuilt only when `treeKey` changes (growth quantized to 0.01, shares to 0.05). Don't
  rebuild per frame. Static layers (`tree.layer`, `bg`) are offscreen canvases.
- Frame loop is throttled to `FPS = 12` for a retro feel. Use `performance.now()` inside `frame()`,
  not the rAF timestamp argument. Prefer time-based motion (scale by elapsed frames), because hidden
  webviews and headless browsers deliver few frames.

## Common tasks

**Add an agent (e.g. Gemini CLI):** implement `UsageProvider` in `src/providers/<name>.ts`, reusing
`JsonlScanner` if the logs are JSONL. Return `lifetime`, 10-minute `buckets` via `addToBucket`,
optional `quotas`, and `searchedDirs` for the "not found" hint. Register it in the `UsageService`
constructor. Add a palette entry in `PALETTES` in `tree.js` (unknown ids fall back to `_0`/`_1`) and
a short label in `updateStatus()` in `extension.ts`. Verify the log format against real files on disk
before writing the parser.

**Add a setting:** declare it under `contributes.configuration` in `package.json` (prefix
`quotaTree.`), read it via `cfg()` in `usageService.ts`, and document it in README "Settings".
Config changes already trigger a refresh.

**Change a log format assumption:** sample a real record first, e.g.
`grep -o '"type":"token_count".\{0,500\}' <file> | tail -1`. Never print credential files or tokens.

## Verifying changes

1. `npm run compile` and `node --check media/tree.js`.
2. Run providers against real logs without VS Code. They don't import `vscode`:
   ```sh
   node -e "const {ClaudeProvider}=require('./out/providers/claude');new ClaudeProvider(()=>[]).collect().then(u=>console.log(u.sessions,u.lifetime))"
   ```
3. For renderer changes, render a static harness in headless Chrome: an HTML page that loads
   `tree.css` and `tree.js`, defines `window.acquireVsCodeApi` to post a fake `update` payload on
   `ready`, and overrides `requestAnimationFrame` with `setTimeout(..., 40)` (headless runs very few rAF
   frames). Screenshot it with `chrome --headless=new --allow-file-access-from-files --virtual-time-budget=5000 --screenshot=out.png file:///…`
   and check sapling, young, full and overflow stages. Keep harness files out of the repo (use a temp dir).
4. Final check: F5 in VS Code. Confirm the view, status bar, window buttons and click-to-refresh all work.

## Conventions

- TypeScript `strict`, CommonJS, target ES2022. No runtime dependencies. Keep it that way unless
  there's a strong reason. Dev deps only: `typescript`, `@types/vscode`, `@types/node`.
- `engines.vscode` is `^1.85.0`. Don't use newer VS Code APIs without bumping it.
- Avoid circular imports between `extension.ts` and other modules. Shared helpers (e.g. `setWindow`)
  live in `usageService.ts`.
- Format token counts with `fmtTokens` (TS) / `fmt` (webview). Use 1.2k / 3.4M / 1.10B style.
- Update README.md when you change the visual mapping, data sources or settings.
