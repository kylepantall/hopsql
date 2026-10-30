/**
 * Database credentials kept in AWS Secrets Manager, in the shape RDS writes
 * (`username`, `password`), so a rotated password is picked up without
 * re-saving it anywhere.
 */

import { registerPrivateValue } from '../privacy.js';
import type { DatabaseConnection } from '../types.js';
import { decorateAwsError, spawnAwsCli, type AwsCommandRunner } from './iam-auth.js';

/** Long enough to share one lookup across a pool's startup, short enough to follow rotation. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CLI_TIMEOUT_MS = 20000;

export interface SecretCredentials {
  user?: string;
  password?: string;
}

const cache = new Map<string, { value: SecretCredentials; expiresAt: number }>();

export function clearSecretCache(): void {
  cache.clear();
}

/** Credentials from the connection's `awsSecret`, or undefined when it has none. */
export async function resolveSecretCredentials(
  connection: DatabaseConnection,
  runner: AwsCommandRunner = spawnAwsCli,
  now = Date.now()
): Promise<SecretCredentials | undefined> {
  const secret = connection.awsSecret;
  if (!secret) return undefined;
  const region = secret.region ?? connection.ssm?.region;
  const profile = secret.profile ?? connection.ssm?.profile;
  const key = JSON.stringify([secret.secretId, region, profile]);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const args = [
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    secret.secretId,
    '--query',
    'SecretString',
    '--output',
    'text',
    ...(region ? ['--region', region] : []),
    ...(profile ? ['--profile', profile] : []),
  ];
  let stdout: string;
  try {
    stdout = await runner(args, DEFAULT_CLI_TIMEOUT_MS);
  } catch (error) {
    throw decorateAwsError(error, profile);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Secret for connection "${connection.name}" is not a JSON object`);
  }
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const value: SecretCredentials = {
    user: text(parsed.username),
    password: text(parsed.password),
  };
  registerPrivateValue(value.user);
  registerPrivateValue(value.password);
  if (!value.password)
    throw new Error(`Secret for connection "${connection.name}" has no password field`);
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
