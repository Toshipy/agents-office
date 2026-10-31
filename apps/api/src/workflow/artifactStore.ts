/**
 * Artifact 保存（S3 の代替としてローカルファイルシステムを使用）。
 * パスは workspaces/<ws>/runs/<run>/... だが、パス名はアクセス制御にならないため
 * 取得は必ず API で Workspace 所有権を確認した後に行う（基本設計書 7.3）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { Db } from '../db/client';
import { artifacts } from '../db/schema';
import { newId } from '../lib/ids';
import { sha256Hex } from '../lib/crypto';

export type ArtifactKind = (typeof artifacts.$inferSelect)['kind'];
export type ArtifactRow = typeof artifacts.$inferSelect;

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export class ArtifactStore {
  /** memory モード（テスト）ではファイルの代わりに Map に保存 */
  private memory = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly baseDir: string | 'memory',
  ) {}

  private pathFor(uri: string): string {
    if (this.baseDir === 'memory') return uri;
    const full = resolve(this.baseDir, uri);
    const rel = relative(this.baseDir, full);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error('artifact path escapes base');
    return full;
  }

  async put(args: {
    workspaceId: string;
    runId: string;
    stepId: string | null;
    kind: ArtifactKind;
    title: string;
    filename: string;
    mediaType: string;
    content: string;
  }): Promise<ArtifactRow> {
    for (const seg of [args.workspaceId, args.runId, args.filename]) {
      if (!SAFE_SEGMENT.test(seg)) throw new Error(`unsafe artifact path segment: ${seg}`);
    }
    const id = newId('art');
    const uri = `workspaces/${args.workspaceId}/runs/${args.runId}/${id}-${args.filename}`;
    if (this.baseDir === 'memory') {
      this.memory.set(uri, args.content);
    } else {
      const full = this.pathFor(uri);
      await mkdir(resolve(full, '..'), { recursive: true });
      await writeFile(full, args.content, { encoding: 'utf8', mode: 0o600 });
    }
    const [row] = await this.db
      .insert(artifacts)
      .values({
        id,
        workspaceId: args.workspaceId,
        runId: args.runId,
        stepId: args.stepId,
        kind: args.kind,
        title: args.title,
        uri,
        mediaType: args.mediaType,
        sizeBytes: Buffer.byteLength(args.content, 'utf8'),
        checksum: `sha256:${sha256Hex(args.content)}`,
      })
      .returning();
    return row;
  }

  /** 呼び出し前に Workspace 所有権を確認済みであること */
  async read(row: ArtifactRow): Promise<string> {
    if (this.baseDir === 'memory') return this.memory.get(row.uri) ?? '';
    const content = await readFile(this.pathFor(row.uri), 'utf8');
    if (`sha256:${sha256Hex(content)}` !== row.checksum) throw new Error('artifact checksum mismatch');
    return content;
  }
}
