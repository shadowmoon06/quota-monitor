import * as vscode from 'vscode';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import {
  AgentUsage, BUCKET_MS, QuotaInfo, TokenCounts, UsageProvider, addCounts, emptyCounts, totalOf,
} from './providers/types';

export type WindowId = '5h' | 'today' | '7d' | '30d';

export const WINDOWS: Record<WindowId, { label: string; autoTokensPerLeaf: number }> = {
  '5h': { label: 'Last 5 hours', autoTokensPerLeaf: 10_000 },
  today: { label: 'Today', autoTokensPerLeaf: 25_000 },
  '7d': { label: 'Last 7 days', autoTokensPerLeaf: 100_000 },
  '30d': { label: 'Last 30 days', autoTokensPerLeaf: 400_000 },
};

export interface AgentView {
  id: string;
  name: string;
  available: boolean;
  searchedDirs: string[];
  sessions: number;
  lifetimeTokens: number;
  windowTokens: number;
  windowBreakdown: TokenCounts;
  quotas: QuotaInfo[];
  lastActivity?: number;
}

export interface Snapshot {
  window: WindowId;
  windowLabel: string;
  tokensPerLeaf: number;
  countCacheReads: boolean;
  generatedAt: number;
  agents: AgentView[];
}

function cfg() {
  return vscode.workspace.getConfiguration('quotaTree');
}

function windowStart(w: WindowId, now: number): number {
  switch (w) {
    case '5h': return now - 5 * 3600_000;
    case '7d': return now - 7 * 86400_000;
    case '30d': return now - 30 * 86400_000;
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
  }
}

function sumSince(u: AgentUsage, since: number): TokenCounts {
  const out = emptyCounts();
  // A bucket counts if any part of it falls inside the window.
  const from = since - BUCKET_MS;
  for (const [k, v] of u.buckets) if (k > from) addCounts(out, v);
  return out;
}

export class UsageService implements vscode.Disposable {
  private readonly providers: UsageProvider[];
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  readonly onDidUpdate = this.emitter.event;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  latest?: Snapshot;

  constructor() {
    this.providers = [
      new ClaudeProvider(() => cfg().get<string[]>('claude.dataDirs', [])),
      new CodexProvider(() => cfg().get<string[]>('codex.dataDirs', [])),
    ];
  }

  start(): void {
    this.schedule();
    void this.refresh();
  }

  schedule(): void {
    if (this.timer) clearInterval(this.timer);
    const sec = Math.max(5, cfg().get<number>('refreshIntervalSeconds', 30));
    this.timer = setInterval(() => void this.refresh(), sec * 1000);
  }

  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.doRefresh().finally(() => (this.running = undefined));
    }
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    const c = cfg();
    const win = (c.get<string>('window', '5h') as WindowId) in WINDOWS ? (c.get<string>('window') as WindowId) : '5h';
    const withCache = c.get<boolean>('countCacheReads', false);
    const now = Date.now();
    const start = windowStart(win, now);

    const results = await Promise.all(
      this.providers.map((p) =>
        p.collect().catch((e): AgentUsage => {
          console.error(`[quotaTree] ${p.name} failed`, e);
          return {
            id: p.id, name: p.name, available: false, searchedDirs: [], lifetime: emptyCounts(),
            buckets: new Map(), quotas: [], sessions: 0,
          };
        }),
      ),
    );

    const agents: AgentView[] = results.map((u) => {
      const w = sumSince(u, start);
      const quotas = [...u.quotas];
      if (u.id === 'claude') {
        const b5 = c.get<number>('claude.tokenBudget5h', 0);
        const bw = c.get<number>('claude.tokenBudgetWeekly', 0);
        if (b5 > 0) {
          quotas.push({ label: '5h budget', usedPercent: (100 * totalOf(sumSince(u, now - 5 * 3600_000), withCache)) / b5, source: 'budget' });
        }
        if (bw > 0) {
          quotas.push({ label: 'weekly budget', usedPercent: (100 * totalOf(sumSince(u, now - 7 * 86400_000), withCache)) / bw, source: 'budget' });
        }
      }
      return {
        id: u.id,
        name: u.name,
        available: u.available,
        searchedDirs: u.searchedDirs,
        sessions: u.sessions,
        lifetimeTokens: totalOf(u.lifetime, withCache),
        windowTokens: totalOf(w, withCache),
        windowBreakdown: w,
        quotas,
        lastActivity: u.lastActivity,
      };
    });

    const tpl = c.get<number>('tokensPerLeaf', 0);
    this.latest = {
      window: win,
      windowLabel: WINDOWS[win].label,
      tokensPerLeaf: tpl > 0 ? tpl : WINDOWS[win].autoTokensPerLeaf,
      countCacheReads: withCache,
      generatedAt: now,
      agents,
    };
    this.emitter.fire(this.latest);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

export async function setWindow(id: WindowId): Promise<void> {
  await cfg().update('window', id, vscode.ConfigurationTarget.Global);
}
