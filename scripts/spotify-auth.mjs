#!/usr/bin/env node
// Local-only Spotify OAuth helper.
//
// Prints a Spotify refresh token to your terminal once so you can paste it
// into GitHub Secrets. Nothing is written to disk. Do not commit output.
//
// Redirect URI (must match the one you register in the Spotify Dashboard,
// exactly — Spotify requires a loopback IP, not `localhost`):
//   http://127.0.0.1:8888/callback

import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { URL } from 'node:url';

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPE = 'user-read-recently-played';
const PORT = 8888;
const HOST = '127.0.0.1';

function prompt(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (silent && process.stdin.isTTY) {
      const stdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, enc, cb) => {
        if (typeof chunk === 'string' && chunk.startsWith(question)) return stdoutWrite(question, enc, cb);
        return stdoutWrite('', enc, cb);
      };
      rl.question(question, (answer) => {
        process.stdout.write = stdoutWrite;
        process.stdout.write('\n');
        rl.close();
        resolve(answer.trim());
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

async function main() {
  console.log('Spotify OAuth helper (local, one-time)');
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`Scope:        ${SCOPE}`);
  console.log('Register the redirect URI in your Spotify Dashboard EXACTLY as shown above.');
  console.log('This script does not write your credentials to disk.\n');

  const clientId = await prompt('Client ID: ');
  const clientSecret = await prompt('Client Secret (input hidden): ', { silent: true });
  if (!clientId || !clientSecret) {
    console.error('Client ID and Client Secret are required.');
    process.exit(1);
  }

  const state = crypto.randomBytes(24).toString('hex');
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('state', state);

  const server = http.createServer();
  const codePromise = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url, `http://${HOST}:${PORT}`);
      if (u.pathname !== '/callback') {
        res.statusCode = 404; res.end('Not found'); return;
      }
      const returnedState = u.searchParams.get('state');
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (err) {
        res.statusCode = 400; res.end(`Spotify returned error: ${err}`);
        reject(new Error(`Spotify authorization error: ${err}`)); return;
      }
      if (!returnedState || returnedState !== state) {
        res.statusCode = 400; res.end('State mismatch. Aborting.');
        reject(new Error('OAuth state mismatch')); return;
      }
      if (!code) {
        res.statusCode = 400; res.end('Missing code parameter.');
        reject(new Error('Missing authorization code')); return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body><h2>Spotify authorization received.</h2><p>You can close this tab and return to your terminal.</p></body></html>');
      resolve(code);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${PORT} is already in use. Free it and re-run this script.`));
      } else {
        reject(err);
      }
    });
    server.listen(PORT, HOST, resolve);
  });

  console.log('\nOpen this URL in your browser to authorize:\n');
  console.log(`  ${authUrl.toString()}\n`);
  console.log('Waiting for redirect to /callback ...');

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    console.error(`Token exchange failed with HTTP ${res.status}. Check that your Client ID/Secret are correct and the redirect URI matches EXACTLY (http://127.0.0.1:8888/callback).`);
    process.exit(1);
  }
  const json = await res.json();
  if (!json.refresh_token) {
    console.error('No refresh_token in response. Spotify only issues one on the first authorization for a given app + user.');
    process.exit(1);
  }

  console.log('\n=====================================================');
  console.log('SUCCESS. Add this value to GitHub Secrets as SPOTIFY_REFRESH_TOKEN:');
  console.log('-----------------------------------------------------');
  console.log(json.refresh_token);
  console.log('=====================================================');
  console.log('Also add: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
  console.log('Do NOT commit this token anywhere.');
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
