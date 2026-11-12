import * as os from 'os';
import * as path from 'path';
import { JsonlScanner, dirExists } from './jsonlScanner';
import {
  AgentUsage, QuotaInfo, TokenCounts, UsageProvider, addCounts, addToBucket, emptyCounts, num,
} from './types';

interface RateLimitSnapshot {
  ts: number;
  primary?: RawLimit;
  secondary?: RawLimit;
}
interface RawLimit {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface CodexFileData {
  prevTotal: TokenCounts | null;
  lifetime: TokenCounts;
  buckets: Map<number, TokenCounts>;
  lastTs: number;
  hasUsage: boolean;
  rate?: RateLimitSnapshot;
}

/** Codex usage objects: input_tokens includes cached_input_tokens; reasoning is part of output. */
function toCounts(u: any): TokenCounts {
  const input = num(u?.input_tokens);
  const cached = num(u?.cached_input_tokens);
  return {
    input: Math.max(0, input - cached),
    output: num(u?.output_tokens),
    cacheRead: cached,
    cacheWrite: num(u?.cache_write_input_tokens),
  };
}

/**
 * Codex writes rollout-*.jsonl files under <codex home>/sessions/YYYY/MM/DD/.
 * `event_msg` records with payload.type === 'token_count' carry cumulative session usage
 * and the account's real rate-limit percentages.
 */
export class CodexProvider implements UsageProvider {
  readonly id = 'codex';
  readonly name = 'Codex';

  private scanner = new JsonlScanner<CodexFileData>(
    () => ({ prevTotal: null, lifetime: emptyCounts(), buckets: new Map(), lastTs: 0, hasUsage: false }),
    (rec, d) => this.onRecord(rec, d),
    (line) => line.includes('"token_count"'),
  );

  constructor(private readonly dirsOverride: () => string[]) {}

  private homes(): string[] {
    const o = this.dirsOverride();
    if (o.length) return o;
    return process.env.CODEX_HOME ? [process.env.CODEX_HOME] : [path.join(os.homedir(), '.codex')];
  }

  private onRecord(rec: any, d: CodexFileData): void {
    const p = rec?.payload;
    if (rec?.type !== 'event_msg' || p?.type !== 'token_count') return;
    const ts = Date.parse(rec.timestamp) || Date.now();

    if (p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) {
      if (!d.rate || ts >= d.rate.ts) {
        d.rate = { ts, primary: p.rate_limits.primary ?? undefined, secondary: p.rate_limits.secondary ?? undefined };
      }
    }

    const info = p.info;
    if (!info?.total_token_usage) return;
    const total = toCounts(info.total_token_usage);
    let delta: TokenCounts;
    if (!d.prevTotal) {
      delta = total;
    } else {
      delta = {
        input: total.input - d.prevTotal.input,
        output: total.output - d.prevTotal.output,
        cacheRead: total.cacheRead - d.prevTotal.cacheRead,
        cacheWrite: total.cacheWrite - d.prevTotal.cacheWrite,
      };
      if (delta.input < 0 || delta.output < 0 || delta.cacheRead < 0 || delta.cacheWrite < 0) {
        // counter reset (e.g. context compaction); fall back to the per-turn usage
        delta = info.last_token_usage ? toCounts(info.last_token_usage) : emptyCounts();
      }
    }
    d.prevTotal = total;
    if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite === 0) return;
    addCounts(d.lifetime, delta);
    addToBucket(d.buckets, ts, delta);
    d.lastTs = Math.max(d.lastTs, ts);
    d.hasUsage = true;
  }

  async collect(): Promise<AgentUsage> {
    const roots: string[] = [];
    const searched: string[] = [];
    for (const home of this.homes()) {
      for (const sub of ['sessions', 'archived_sessions']) {
        const p = path.join(home, sub);
        if (sub === 'sessions') searched.push(p);
        if (await dirExists(p)) roots.push(p);
      }
    }
    const files = await this.scanner.scan(roots);
    const usage: AgentUsage = {
      id: this.id,
      name: this.name,
      available: roots.length > 0,
      searchedDirs: searched,
      lifetime: emptyCounts(),
      buckets: new Map(),
      quotas: [],
      sessions: 0,
    };
    let rate: RateLimitSnapshot | undefined;
    for (const f of files) {
      if (f.rate && (!rate || f.rate.ts > rate.ts)) rate = f.rate;
      if (!f.hasUsage) continue;
      usage.sessions++;
      addCounts(usage.lifetime, f.lifetime);
      for (const [k, v] of f.buckets) addToBucket(usage.buckets, k, v);
      if (f.lastTs > (usage.lastActivity ?? 0)) usage.lastActivity = f.lastTs;
    }
    if (rate) {
      for (const lim of [rate.primary, rate.secondary]) {
        const q = toQuota(lim);
        if (q) usage.quotas.push(q);
      }
    }
    return usage;
  }
}

function toQuota(l: RawLimit | undefined): QuotaInfo | undefined {
  if (!l || typeof l.used_percent !== 'number') return undefined;
  const resetsAt = l.resets_at ? l.resets_at * 1000 : undefined;
  // The snapshot is from the last Codex turn; if the window has since reset, usage is 0.
  const expired = resetsAt !== undefined && resetsAt < Date.now();
  return {
    label: windowLabel(l.window_minutes),
    usedPercent: expired ? 0 : l.used_percent,
    resetsAt: expired ? undefined : resetsAt,
    source: 'reported',
  };
}

function windowLabel(min?: number): string {
  if (!min) return 'limit';
  if (min === 10080) return 'weekly';
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}
