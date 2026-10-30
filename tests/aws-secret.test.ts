import { afterEach, describe, expect, it } from 'bun:test';
import { clearSecretCache, resolveSecretCredentials } from '../src/auth/aws-secret.js';
import { sanitizeDiagnostic } from '../src/privacy.js';
import type { DatabaseConnection } from '../src/types.js';

afterEach(clearSecretCache);

const connection: DatabaseConnection = {
  id: 'secret-db',
  name: 'secret-db',
  driver: 'postgresql',
  url: '',
  ssm: { targetName: 'bastion', mode: 'port-forward', region: 'eu-west-2', profile: 'prod' },
  awsSecret: { secretId: 'prod/cluster' },
};

describe('Secrets Manager credentials', () => {
  it('reads username and password with the SSM hop region and profile', async () => {
    const calls: string[][] = [];
    const creds = await resolveSecretCredentials(connection, async (args) => {
      calls.push(args);
      return JSON.stringify({ username: 'reader', password: 'synthetic-secret-1' });
    });
    expect(creds).toEqual({ user: 'reader', password: 'synthetic-secret-1' });
    expect(calls[0].slice(0, 2)).toEqual(['secretsmanager', 'get-secret-value']);
    expect(calls[0][calls[0].indexOf('--secret-id') + 1]).toBe('prod/cluster');
    expect(calls[0][calls[0].indexOf('--region') + 1]).toBe('eu-west-2');
    expect(calls[0][calls[0].indexOf('--profile') + 1]).toBe('prod');
    expect(sanitizeDiagnostic('pw synthetic-secret-1')).not.toContain('synthetic-secret-1');
  });

  it('caches a lookup and refetches after it expires', async () => {
    let count = 0;
    const runner = async () => {
      count += 1;
      return JSON.stringify({ password: `synthetic-${count}` });
    };
    await resolveSecretCredentials(connection, runner, 0);
    await resolveSecretCredentials(connection, runner, 1000);
    expect(count).toBe(1);
    const later = await resolveSecretCredentials(connection, runner, 10 * 60 * 1000);
    expect(count).toBe(2);
    expect(later?.password).toBe('synthetic-2');
  });

  it('is a no-op without awsSecret and rejects secrets with no password', async () => {
    const fail = async () => {
      throw new Error('not called');
    };
    expect(await resolveSecretCredentials({ ...connection, awsSecret: undefined }, fail)).toBe(
      undefined
    );
    await expect(
      resolveSecretCredentials(connection, async () => JSON.stringify({ username: 'x' }))
    ).rejects.toThrow();
    await expect(resolveSecretCredentials(connection, async () => 'not json')).rejects.toThrow();
  });
});
