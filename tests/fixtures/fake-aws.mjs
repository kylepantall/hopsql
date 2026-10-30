#!/usr/bin/env node
// Stand-in for `aws ssm start-session`, used via HOPSQL_AWS_CLI_PATH.
//  - AWS-StartSSHSession: bridges stdio to 127.0.0.1:<portNumber>.
//  - AWS-StartPortForwardingSessionToRemoteHost: listens on localPortNumber,
//    forwards to host:portNumber, and prints the plugin's ready lines.
// FAKE_AWS_LOG appends each argv as a JSON line; FAKE_AWS_FAIL=sso exits the
// way the CLI does with an expired SSO session.
//  - ec2 describe-instances: prints FAKE_AWS_INSTANCE_ID (default i-0fa4e0001).
//  - secretsmanager get-secret-value: prints FAKE_AWS_SECRET.
import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';

const args = process.argv.slice(2);
if (process.env.FAKE_AWS_LOG) fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\n');

if (process.env.FAKE_AWS_FAIL === 'sso') {
  process.stderr.write('Error loading SSO Token: Token for example does not exist or has expired\n');
  process.exit(255);
}

if (args[0] === 'ec2' && args[1] === 'describe-instances') {
  process.stdout.write(`${process.env.FAKE_AWS_INSTANCE_ID ?? 'i-0fa4e0001'}\n`);
  process.exit(0);
}
if (args[0] === 'secretsmanager' && args[1] === 'get-secret-value') {
  process.stdout.write(`${process.env.FAKE_AWS_SECRET ?? '{}'}\n`);
  process.exit(0);
}

const option = (name) => args[args.indexOf(name) + 1];
const params = Object.fromEntries(
  (option('--parameters') ?? '').split(',').map((pair) => pair.split('='))
);
const documentName = option('--document-name');

if (documentName === 'AWS-StartSSHSession') {
  const upstream = net.connect(Number(params.portNumber), '127.0.0.1');
  process.stdin.pipe(upstream).pipe(process.stdout);
  upstream.on('close', () => process.exit(0));
  upstream.on('error', () => process.exit(1));
} else if (documentName === 'AWS-StartPortForwardingSessionToRemoteHost') {
  const server = net.createServer((socket) => {
    const upstream = net.connect(Number(params.portNumber), params.host);
    socket.pipe(upstream).pipe(socket);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  server.listen(Number(params.localPortNumber), '127.0.0.1', () => {
    process.stdout.write('\nStarting session with SessionId: fake-0123\n');
    process.stdout.write(`Port ${params.localPortNumber} opened for sessionId fake-0123.\n`);
    process.stdout.write('Waiting for connections...\n');
  });
  process.on('SIGTERM', () => process.exit(0));
} else {
  process.stderr.write('unsupported fake aws invocation\n');
  process.exit(2);
}
