/**
 * Hopsql was renamed from OmniSQL. Existing MCP registrations and shells still
 * export `OMNISQL_*`, so copy each one to its `HOPSQL_*` name when that is
 * unset. Imported first by the entry point, before any module reads settings.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('OMNISQL_') || value === undefined) continue;
    const renamed = `HOPSQL_${key.slice('OMNISQL_'.length)}`;
    if (env[renamed] === undefined) env[renamed] = value;
  }
}

applyLegacyEnv();
