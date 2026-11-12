export interface TokenCounts {
  /** Fresh (uncached) input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface QuotaInfo {
  label: string;
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** 'reported' = from the agent itself, 'budget' = computed from a user-set budget. */
  source: 'reported' | 'budget';
}

export interface AgentUsage {
  id: string;
  name: string;
  available: boolean;
  /** Where we looked, for hints when nothing is found. */
  searchedDirs: string[];
  lifetime: TokenCounts;
  /** Bucket start (epoch ms, BUCKET_MS aligned) -> counts. */
  buckets: Map<number, TokenCounts>;
  quotas: QuotaInfo[];
  lastActivity?: number;
  sessions: number;
}

export interface UsageProvider {
  readonly id: string;
  readonly name: string;
  collect(): Promise<AgentUsage>;
}

export const BUCKET_MS = 10 * 60 * 1000;

export function emptyCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addCounts(target: TokenCounts, src: TokenCounts): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheWrite += src.cacheWrite;
}

export function addToBucket(buckets: Map<number, TokenCounts>, ts: number, c: TokenCounts): void {
  const key = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
  let b = buckets.get(key);
  if (!b) {
    b = emptyCounts();
    buckets.set(key, b);
  }
  addCounts(b, c);
}

export function totalOf(c: TokenCounts, includeCacheReads: boolean): number {
  return c.input + c.output + c.cacheWrite + (includeCacheReads ? c.cacheRead : 0);
}

export function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}
