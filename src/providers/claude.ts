import * as os from 'os';
import * as path from 'path';
import { JsonlScanner, dirExists } from './jsonlScanner';
import {
  AgentUsage, TokenCounts, UsageProvider, addCounts, addToBucket, emptyCounts, num,
} from './types';

interface ClaudeFileData {
  seen: Set<string>;
  lifetime: TokenCounts;
  buckets: Map<number, TokenCounts>;
  lastTs: number;
  hasUsage: boolean;
}

/**
 * Claude Code writes one JSONL transcript per session under <config>/projects/<project>/.
 * Assistant records carry `message.usage`. Streaming can repeat the same message, so we
 * de-duplicate on message id + request id.
 */
export class ClaudeProvider implements UsageProvider {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private scanner = new JsonlScanner<ClaudeFileData>(
    () => ({ seen: new Set(), lifetime: emptyCounts(), buckets: new Map(), lastTs: 0, hasUsage: false }),
    (rec, d) => this.onRecord(rec, d),
    (line) => line.includes('"usage"'),
  );

  constructor(private readonly dirsOverride: () => string[]) {}

  private configDirs(): string[] {
    const o = this.dirsOverride();
    if (o.length) return o;
    const dirs = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.config', 'claude')];
    for (const env of (process.env.CLAUDE_CONFIG_DIR ?? '').split(',')) {
      if (env.trim()) dirs.unshift(env.trim());
    }
    return [...new Set(dirs)];
  }

  private onRecord(rec: any, d: ClaudeFileData): void {
    const msg = rec?.message;
    const u = msg?.usage;
    if (rec?.type !== 'assistant' || !u || msg?.model === '<synthetic>') return;
    const key = `${msg.id ?? ''}:${rec.requestId ?? ''}`;
    if (key !== ':') {
      if (d.seen.has(key)) return;
      d.seen.add(key);
    }
    const c: TokenCounts = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
    };
    const ts = Date.parse(rec.timestamp) || Date.now();
    addCounts(d.lifetime, c);
    addToBucket(d.buckets, ts, c);
    d.lastTs = Math.max(d.lastTs, ts);
    d.hasUsage = true;
  }

  async collect(): Promise<AgentUsage> {
    const roots: string[] = [];
    for (const dir of this.configDirs()) {
      const p = path.join(dir, 'projects');
      if (await dirExists(p)) roots.push(p);
    }
    const files = await this.scanner.scan(roots);
    const usage: AgentUsage = {
      id: this.id,
      name: this.name,
      available: roots.length > 0,
      searchedDirs: this.configDirs().map((d) => path.join(d, 'projects')),
      lifetime: emptyCounts(),
      buckets: new Map(),
      quotas: [],
      sessions: 0,
    };
    for (const f of files) {
      if (!f.hasUsage) continue;
      usage.sessions++;
      addCounts(usage.lifetime, f.lifetime);
      for (const [k, v] of f.buckets) addToBucket(usage.buckets, k, v);
      if (f.lastTs > (usage.lastActivity ?? 0)) usage.lastActivity = f.lastTs;
    }
    return usage;
  }
}
