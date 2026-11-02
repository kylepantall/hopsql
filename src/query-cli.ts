/**
 * `hopsql query <connection> (<sql> | --file <query.sql>) [--write]`: one
 * statement through execute_query or write_query, under the server's policy.
 */

const USAGE =
  'Usage: hopsql query <connection> (<sql> | --file <query.sql>) [--write] [--database <name>] [--max-rows <n>]';

export function parseQueryArgs(argv: string[]): {
  tool: 'execute_query' | 'write_query';
  args: Record<string, unknown>;
} {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw new Error(USAGE);
      return argv[++i];
    };
    if (arg === '--write') write = true;
    else if (arg === '--file') args.file = value();
    else if (arg === '--database') args.database = value();
    else if (arg === '--max-rows') {
      const rows = Number(value());
      if (!Number.isInteger(rows) || rows < 1)
        throw new Error('--max-rows must be a positive integer');
      args.maxRows = rows;
    } else if (arg.startsWith('--')) throw new Error(USAGE);
    else positional.push(arg);
  }
  const [connectionId, ...sql] = positional;
  if (!connectionId || sql.length > 0 === (args.file !== undefined)) throw new Error(USAGE);
  if (sql.length > 0) args.query = sql.join(' ');
  if (write && args.maxRows !== undefined) throw new Error('--max-rows applies to read queries');
  return { tool: write ? 'write_query' : 'execute_query', args: { connectionId, ...args } };
}
