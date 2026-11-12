import * as fs from 'fs';
import * as path from 'path';

interface FileState<T> {
  /** Byte offset of the first unparsed byte (always just after a newline). */
  offset: number;
  data: T;
}

const CHUNK = 8 * 1024 * 1024;

/**
 * Incrementally parses every *.jsonl file under a set of roots.
 * Only bytes appended since the previous scan are read, so rescans are cheap.
 */
export class JsonlScanner<T> {
  private files = new Map<string, FileState<T>>();

  constructor(
    private readonly init: () => T,
    private readonly onRecord: (record: any, data: T) => void,
    /** Cheap string test to skip JSON.parse on irrelevant lines. */
    private readonly prefilter: (line: string) => boolean,
  ) {}

  async scan(roots: string[]): Promise<T[]> {
    const found = new Set<string>();
    for (const root of roots) {
      await walk(root, found);
    }
    for (const f of [...this.files.keys()]) {
      if (!found.has(f)) this.files.delete(f);
    }
    for (const f of found) {
      try {
        await this.update(f);
      } catch {
        // file vanished or locked; try again next scan
      }
    }
    return [...this.files.values()].map((s) => s.data);
  }

  private async update(file: string): Promise<void> {
    const st = await fs.promises.stat(file);
    let s = this.files.get(file);
    if (s && st.size < s.offset) s = undefined; // truncated/rewritten: reparse
    if (!s) {
      s = { offset: 0, data: this.init() };
      this.files.set(file, s);
    }
    if (st.size <= s.offset) return;

    const fh = await fs.promises.open(file, 'r');
    try {
      while (s.offset < st.size) {
        const len = Math.min(CHUNK, st.size - s.offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, s.offset);
        if (bytesRead <= 0) break;
        const lastNl = buf.lastIndexOf(0x0a, bytesRead - 1);
        if (lastNl < 0) {
          // No complete line in this chunk. If the chunk is full, the line is huge: skip past it.
          if (bytesRead === CHUNK) {
            s.offset += bytesRead;
            continue;
          }
          break; // partial line still being written
        }
        const text = buf.toString('utf8', 0, lastNl);
        s.offset += lastNl + 1;
        for (const line of text.split('\n')) {
          if (!line || !this.prefilter(line)) continue;
          let rec: any;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          this.onRecord(rec, s.data);
        }
      }
    } finally {
      await fh.close();
    }
  }
}

async function walk(dir: string, out: Set<string>, depth = 0): Promise<void> {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.add(p);
  }
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
