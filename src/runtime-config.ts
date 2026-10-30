import type { DatabaseConnection, ExportSettings } from './types.js';
export function booleanSetting(value: string | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false')
    throw new Error(`${name} must be true or false`);
  return normalized === 'true';
}

export function integerSetting(
  value: string | undefined,
  name: string,
  fallback: number,
  min = 1,
  max = 300000
): number {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(value);
}

const MIB = 1024 * 1024;

/**
 * A global export or dump cap, tightened by the connection's own byte and
 * timeout limits where it sets them; a connection never loosens the global cap.
 */
export function connectionStreamLimits<T extends { maxBytes: number; timeoutMs: number }>(
  limits: T,
  connection: Pick<DatabaseConnection, 'limits'>
): T {
  return {
    ...limits,
    maxBytes: Math.min(limits.maxBytes, connection.limits?.maxBytes ?? Infinity),
    timeoutMs: Math.min(limits.timeoutMs, connection.limits?.timeoutMs ?? Infinity),
  };
}

/** Streamed export and dump caps; byte caps never exceed the artifact store quota. */
export function exportSettings(env: NodeJS.ProcessEnv = process.env): ExportSettings {
  const quota = integerSetting(
    env.HOPSQL_ARTIFACT_QUOTA_BYTES,
    'HOPSQL_ARTIFACT_QUOTA_BYTES',
    64 * MIB,
    MIB,
    64 * 1024 * MIB
  );
  const bytes = (name: string, fallback: number) =>
    Math.min(
      integerSetting(env[name], name, Math.min(fallback, quota), 1024, 64 * 1024 * MIB),
      quota
    );
  return {
    artifactQuotaBytes: quota,
    export: {
      maxRows: integerSetting(
        env.HOPSQL_EXPORT_MAX_ROWS,
        'HOPSQL_EXPORT_MAX_ROWS',
        5_000_000,
        1,
        1_000_000_000
      ),
      maxBytes: bytes('HOPSQL_EXPORT_MAX_BYTES', 32 * MIB),
      timeoutMs: integerSetting(
        env.HOPSQL_EXPORT_TIMEOUT_MS,
        'HOPSQL_EXPORT_TIMEOUT_MS',
        300000,
        1000,
        86_400_000
      ),
    },
    dump: {
      maxBytes: bytes('HOPSQL_DUMP_MAX_BYTES', 32 * MIB),
      timeoutMs: integerSetting(
        env.HOPSQL_DUMP_TIMEOUT_MS,
        'HOPSQL_DUMP_TIMEOUT_MS',
        600000,
        1000,
        86_400_000
      ),
    },
  };
}
