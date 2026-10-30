import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createBrotliCompress,
  createGzip,
  createZstdCompress,
  constants as zlibConstants,
} from 'node:zlib';
import type { PoolClient } from 'pg';
import type { PoolConnection } from 'mysql2/promise';
import type { ExportLimitReason, ExportLimits } from '../types.js';
import { convertToCSV } from '../utils.js';
import type { ExportCompression } from './compression.js';
import { withDeadline } from './lease.js';
import { parseJsonValue, resultValue } from './results.js';

/**
 * Incremental CSV/JSON text, byte-for-byte identical to the buffered export
 * (`convertToCSV` and `JSON.stringify` of the whole result).
 */
export class ExportEncoder {
  private columns: string[] = [];
  private rows = 0;
  private keyed = true;
  constructor(
    private format: 'csv' | 'json',
    private includeHeaders = true
  ) {}
  begin(columns: string[]): string {
    this.columns = columns;
    this.keyed = new Set(columns).size === columns.length;
    if (this.format === 'csv') return this.includeHeaders ? convertToCSV(columns, [], true) : '';
    return this.keyed ? '[' : `{"columns":${JSON.stringify(columns)},"rows":[`;
  }
  row(values: unknown[]): string {
    const first = this.rows++ === 0;
    if (this.format === 'csv') return convertToCSV(this.columns, [values], false);
    const value = this.keyed
      ? Object.fromEntries(this.columns.map((name, i) => [name, values[i]]))
      : values;
    return (first ? '' : ',') + JSON.stringify(value);
  }
  end(): string {
    if (this.format === 'csv') return '';
    return this.keyed ? ']' : ']}';
  }
}

/** Writes encoded rows with backpressure while enforcing the row and byte caps. */
export class ExportWriter {
  rows = 0;
  bytes = 0;
  truncated = false;
  limitReason?: ExportLimitReason;
  private started = false;
  constructor(
    private out: Writable,
    private encoder: ExportEncoder,
    private limits: Pick<ExportLimits, 'maxRows' | 'maxBytes'>
  ) {}
  async start(columns: string[]): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.write(this.encoder.begin(columns));
  }
  /** Returns false once a cap is reached; the caller must stop fetching. */
  async add(row: unknown[]): Promise<boolean> {
    if (this.rows >= this.limits.maxRows) return this.stop('rows');
    const text = this.encoder.row(row.map((value) => resultValue(value)));
    const size = Buffer.byteLength(text);
    // Keep room for the closing bracket so a capped JSON export stays valid.
    if (this.bytes + size + 2 > this.limits.maxBytes) return this.stop('bytes');
    await this.write(text);
    this.rows++;
    return true;
  }
  async finish(columns: string[] = []): Promise<void> {
    await this.start(columns);
    await this.write(this.encoder.end());
  }
  private stop(reason: ExportLimitReason): false {
    this.truncated = true;
    this.limitReason = reason;
    return false;
  }
  private async write(text: string): Promise<void> {
    if (!text) return;
    // A failed sink (e.g. artifact quota) stops the export instead of
    // silently discarding the remaining rows.
    if (this.out.destroyed) throw this.out.errored ?? new Error('Export output closed');
    this.bytes += Buffer.byteLength(text);
    if (!this.out.write(text)) await once(this.out, 'drain');
  }
}

function compressor(compression: Exclude<ExportCompression, 'none'>) {
  if (compression === 'gzip') return createGzip({ level: 6 });
  if (compression === 'brotli')
    return createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
  return createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } });
}

/** Run `produce` against `sink`, through a streaming compressor when requested. */
export async function withCompression<T>(
  sink: Writable,
  compression: ExportCompression,
  produce: (out: Writable) => Promise<T>
): Promise<T> {
  if (compression === 'none') return produce(sink);
  const out = compressor(compression);
  const piping = pipeline(out, sink);
  try {
    const value = await produce(out);
    out.end();
    await piping;
    return value;
  } catch (error) {
    out.destroy(error instanceof Error ? error : new Error(String(error)));
    await piping.catch(() => {});
    throw error;
  }
}

export interface StreamOptions {
  timeoutMs: number;
  /** Destroy the physical connection; the lease owner must not release it again. */
  abort: () => void;
}

/** Stream a PostgreSQL SELECT through a cursor, stopping as soon as a cap is hit. */
export async function streamPostgres(
  client: PoolClient,
  query: string,
  writer: ExportWriter,
  options: StreamOptions
): Promise<void> {
  const { default: Cursor } = await import('pg-cursor');
  const cursor = client.query(new Cursor(query, [], { rowMode: 'array' }));
  const fields = () =>
    (cursor as unknown as { _result: { fields: { name: string }[] } })._result.fields.map(
      (f) => f.name
    );
  let timedOut = false;
  try {
    await withDeadline(
      (async () => {
        for (;;) {
          const rows = await cursor.read(256);
          await writer.start(fields());
          let more = rows.length > 0;
          for (const row of rows)
            if (!(await writer.add(row))) {
              more = false;
              break;
            }
          if (!more) break;
        }
        await writer.finish(fields());
      })(),
      options.timeoutMs,
      () => {
        timedOut = true;
        options.abort();
      }
    );
  } catch (error) {
    if (timedOut) throw new Error(`PostgreSQL export timed out after ${options.timeoutMs}ms`);
    throw error;
  } finally {
    if (!timedOut) await cursor.close();
  }
}

/** Stream a MySQL/MariaDB SELECT with `mysql2`'s row stream. */
export async function streamMysql(
  client: PoolConnection,
  query: string,
  writer: ExportWriter,
  options: StreamOptions
): Promise<{ aborted: boolean }> {
  const raw = (client as unknown as { connection: import('mysql2').PoolConnection }).connection;
  const request = raw.query({ sql: query, rowsAsArray: true });
  let columns: string[] = [];
  let jsonColumns: number[] = [];
  request.on('fields', (fields: import('mysql2').FieldPacket[] | undefined) => {
    columns = fields?.map((f) => f.name) ?? [];
    jsonColumns = (fields ?? []).flatMap((field, i) =>
      field.columnType === 245 || field.type === 245 || field.extendedFormat === 'json' ? [i] : []
    );
  });
  const stream = request.stream({ highWaterMark: 64 });
  let aborted = false;
  let timedOut = false;
  try {
    await withDeadline(
      (async () => {
        for await (const row of stream) {
          if (!Array.isArray(row)) continue;
          await writer.start(columns);
          for (const i of jsonColumns)
            if (typeof row[i] === 'string') row[i] = parseJsonValue(row[i], true);
          if (!(await writer.add(row))) {
            // Unread rows would otherwise keep arriving; drop the session.
            aborted = true;
            options.abort();
            break;
          }
        }
        await writer.finish(columns);
      })(),
      options.timeoutMs,
      () => {
        timedOut = true;
        aborted = true;
        stream.destroy();
        options.abort();
      }
    );
  } catch (error) {
    if (timedOut) throw new Error(`MySQL export timed out after ${options.timeoutMs}ms`);
    throw error;
  }
  return { aborted };
}
