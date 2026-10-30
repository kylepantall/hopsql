import { describe, it, expect } from 'bun:test';
import { applyLegacyEnv } from '../src/env-compat.js';

describe('legacy OMNISQL_* settings', () => {
  it('fills an unset HOPSQL_* setting from its OMNISQL_* name', () => {
    const env: NodeJS.ProcessEnv = { OMNISQL_READ_ONLY: 'false', OMNISQL_CONFIG_FILE: '/c.json' };
    applyLegacyEnv(env);
    expect(env.HOPSQL_READ_ONLY).toBe('false');
    expect(env.HOPSQL_CONFIG_FILE).toBe('/c.json');
  });

  it('keeps an explicit HOPSQL_* setting, including an empty one', () => {
    const env: NodeJS.ProcessEnv = {
      OMNISQL_READ_ONLY: 'false',
      HOPSQL_READ_ONLY: 'true',
      OMNISQL_CONFIG_FILE: '/old.json',
      HOPSQL_CONFIG_FILE: '',
    };
    applyLegacyEnv(env);
    expect(env.HOPSQL_READ_ONLY).toBe('true');
    expect(env.HOPSQL_CONFIG_FILE).toBe('');
  });

  it('ignores unrelated variables', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', XOMNISQL_A: '1' };
    applyLegacyEnv(env);
    expect(Object.keys(env).sort()).toEqual(['PATH', 'XOMNISQL_A']);
  });
});
