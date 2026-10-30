import { afterEach, describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import type { PoolClient } from 'pg';
import type { PoolConnection } from 'mysql2/promise';
import { ResultArtifacts } from '../src/runtime/artifacts.js';
import {
  ExportEncoder,
  ExportWriter,
  streamMysql,
  streamPostgres,
  withCompression,
} from '../src/runtime/export-stream.js';
import { ResultCollector } from '../src/runtime/results.js';
import { connectionStreamLimits } from '../src/runtime-config.js';
import { convertToCSV } from '../src/utils.js';
import type { DatabaseConnection } from '../src/types.js';

const connection = { id: 'fixture', name: 'fixture', driver: 'postgresql', url: '' };
const columns = ['id', 'note', 'payload', 'seen_at', 'raw'];
const rows: unknown[][] = [
  [1, 'plain', { a: [1, 2] }, new Date('2026-01-02T03:04:05.000Z'), Buffer.from('hi')],
  [2, 'comma, "quote"\nnewline', null, null, null],
  [3, '日本語 😀', 'text', '2026-01-02', 9007199254740993n],
];
const source = {
  scopes: [
    {
      connectionId: 'fixture',
      access: { kind: 'sql' as const, query: 'SELECT * FROM fixture' },
      connectionFingerprint: 'fixture-identity',
      policyRevision: 'fixture-revision',
    },
  ],
};
const stores: ResultArtifacts[] = [];
afterEach(async () => {
  for (const s of stores) await s.close();
  stores.length = 0;
});

/** The buffered export: collector normalisation, then whole-result text. */
function buffered(cols: string[], data: unknown[][], format: 'csv' | 'json', headers = true) {
  const collector = new ResultCollector(connection as DatabaseConnection, 1000);
  collector.columns = cols;
  for (const row of data) collector.add(row);
  if (format === 'csv') return convertToCSV(cols, collector.rows, headers);
  return JSON.stringify(
    new Set(cols).size !== cols.length
      ? { columns: cols, rows: collector.rows }
      : collector.rows.map((row) => Object.fromEntries(cols.map((name, i) => [name, row[i]])))
  );
}
async function streamed(
  cols: string[],
  data: unknown[][],
  format: 'csv' | 'json',
  limits = { maxRows: 1000, maxBytes: 1024 * 1024 },
  headers = true
) {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (chunk: Buffer) => chunks.push(chunk));
  const writer = new ExportWriter(out, new ExportEncoder(format, headers), limits);
  await writer.start(cols);
  for (const row of data) if (!(await writer.add(row))) break;
  await writer.finish(cols);
  return { text: Buffer.concat(chunks).toString('utf8'), writer };
}

describe('streaming export encoding', () => {
  for (const format of ['csv', 'json'] as const)
    it(`matches the buffered ${format} export byte for byte`, async () => {
      expect((await streamed(columns, rows, format)).text).toBe(buffered(columns, rows, format));
      expect((await streamed(columns, [], format)).text).toBe(buffered(columns, [], format));
      const dup = ['id', 'id'];
      expect((await streamed(dup, [[1, 2]], format)).text).toBe(buffered(dup, [[1, 2]], format));
    });

  it('matches the buffered CSV without headers', async () => {
    const result = await streamed(columns, rows, 'csv', undefined, false);
    expect(result.text).toBe(buffered(columns, rows, 'csv', false));
  });

  it('honours the row cap', async () => {
    const { text, writer } = await streamed(columns, rows, 'json', {
      maxRows: 2,
      maxBytes: 1024 * 1024,
    });
    expect(writer).toMatchObject({ rows: 2, truncated: true, limitReason: 'rows' });
    expect(JSON.parse(text)).toHaveLength(2);
  });

  it('honours the byte cap and keeps JSON valid', async () => {
    const many = Array.from({ length: 500 }, (_, i) => [i, 'x'.repeat(50)]);
    const { text, writer } = await streamed(['id', 'note'], many, 'json', {
      maxRows: 1000,
      maxBytes: 4096,
    });
    expect(writer.truncated).toBe(true);
    expect(writer.limitReason).toBe('bytes');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(writer.bytes).toBe(Buffer.byteLength(text));
    expect(JSON.parse(text)).toHaveLength(writer.rows);
  });
});

describe('streaming export drivers', () => {
  it('reads PostgreSQL cursor batches until a cap', async () => {
    let closed = false;
    const batches = [rows.slice(0, 2), rows.slice(2), []];
    const cursor = {
      _result: { fields: columns.map((name) => ({ name })) },
      read: async () => batches.shift() ?? [],
      close: async () => {
        closed = true;
      },
    };
    const client = { query: () => cursor } as unknown as PoolClient;
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    const writer = new ExportWriter(out, new ExportEncoder('csv'), {
      maxRows: 1000,
      maxBytes: 1024 * 1024,
    });
    await streamPostgres(client, 'SELECT 1', writer, { timeoutMs: 5000, abort: () => {} });
    expect(Buffer.concat(chunks).toString()).toBe(buffered(columns, rows, 'csv'));
    expect(closed).toBe(true);
  });

  it('streams MySQL rows, parses JSON columns, and drops the session at a cap', async () => {
    let aborted = 0;
    const raw = {
      query: () => {
        const request = new EventEmitter() as EventEmitter & { stream: () => Readable };
        request.stream = () => {
          request.emit('fields', [{ name: 'id' }, { name: 'doc', columnType: 245 }]);
          return Readable.from([
            [1, '{"a":1}'],
            [2, '[2]'],
            [3, 'null'],
          ]);
        };
        return request;
      },
    };
    const client = { connection: raw } as unknown as PoolConnection;
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    const writer = new ExportWriter(out, new ExportEncoder('json'), {
      maxRows: 2,
      maxBytes: 1024 * 1024,
    });
    const result = await streamMysql(client, 'SELECT 1', writer, {
      timeoutMs: 5000,
      abort: () => aborted++,
    });
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual([
      { id: 1, doc: { a: 1 } },
      { id: 2, doc: [2] },
    ]);
    expect(result.aborted).toBe(true);
    expect(aborted).toBe(1);
  });
});

describe('per-connection stream limits', () => {
  const global = { maxRows: 100, maxBytes: 32 * 1024 * 1024, timeoutMs: 300000 };
  it('tightens the global byte and timeout caps to the connection limits', () => {
    expect(connectionStreamLimits(global, { limits: { maxBytes: 1024, timeoutMs: 5000 } })).toEqual(
      { maxRows: 100, maxBytes: 1024, timeoutMs: 5000 }
    );
  });
  it('keeps the global caps when the connection sets none or sets looser ones', () => {
    expect(connectionStreamLimits(global, {})).toEqual(global);
    expect(connectionStreamLimits(global, { limits: { maxRows: 5 } })).toEqual(global);
    expect(connectionStreamLimits(global, { limits: { maxBytes: 1e12, timeoutMs: 1e9 } })).toEqual(
      global
    );
  });
});

describe('streaming export artifacts', () => {
  it('compresses while streaming and stores a read_export handle', async () => {
    const store = new ResultArtifacts();
    stores.push(store);
    for (const [codec, decode] of [
      ['gzip', gunzipSync],
      ['zstd', zstdDecompressSync],
    ] as const) {
      const { stored } = await store.exportStream('csv.gz', source, 1024 * 1024, (sink) =>
        withCompression(sink, codec, async (out) => {
          const writer = new ExportWriter(out, new ExportEncoder('csv'), {
            maxRows: 1000,
            maxBytes: 1024 * 1024,
          });
          await writer.start(columns);
          for (const row of rows) await writer.add(row);
          await writer.finish(columns);
        })
      );
      const chunk = await store.readExport(stored.resultId);
      expect(decode(Buffer.from(chunk.data, 'base64')).toString()).toBe(
        buffered(columns, rows, 'csv')
      );
    }
  });

  it('returns small exports inline and leaves nothing on failure', async () => {
    const store = new ResultArtifacts(undefined, 2 * 1024 * 1024);
    stores.push(store);
    const { stored } = await store.exportStream('csv', source, 1024 * 1024, async (sink) => {
      sink.write('a,b\n');
    });
    expect((await store.takeInline(stored.resultId, 65536))?.toString()).toBe('a,b\n');
    expect(() => store.source(stored.resultId)).toThrow();
    await expect(
      store.exportStream('csv', source, 1024 * 1024, async () => {
        throw new Error('driver failed');
      })
    ).rejects.toThrow();
    // The failed reservation was released: a full-quota export still fits.
    const again = await store.exportStream('csv', source, 2 * 1024 * 1024, async (sink) => {
      sink.write('ok');
    });
    expect(again.stored.bytes).toBe(2);
  });
});
