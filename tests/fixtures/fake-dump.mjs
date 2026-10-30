// Stand-in for pg_dump / mysqldump in tests; launched as `node fake-dump.mjs ...args`.
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_DUMP_MODE ?? 'echo';
if (mode === 'sleep') {
  fs.writeFileSync(process.env.FAKE_DUMP_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'flood') {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const write = () => {
    while (process.stdout.write(chunk));
    process.stdout.once('drain', write);
  };
  write();
} else if (mode === 'fail') {
  process.stderr.write('fake dump failure\n');
  process.exit(3);
} else {
  const defaults = args.find((arg) => arg.startsWith('--defaults-file='))?.slice(16);
  process.stdout.write(
    JSON.stringify({
      args,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => /^(PG|MYSQL)/.test(key))
      ),
      defaultsPath: defaults ?? null,
      defaults: defaults ? fs.readFileSync(defaults, 'utf8') : null,
    })
  );
}
