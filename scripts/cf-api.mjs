#!/usr/bin/env node
// Read-only helper for the Cloudflare REST API. Reads the token from the environment
// (run through scripts/with-cf-env.sh) and never prints it.
// Usage: scripts/with-cf-env.sh node scripts/cf-api.mjs /accounts/{account}/workers/scripts
const [path] = process.argv.slice(2);
if (!path) {
  console.error('usage: cf-api.mjs <path>   ({account} and {worker} are expanded)');
  process.exit(2);
}
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_WORKER_NAME: worker } = process.env;
if (!account || !token) {
  console.error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set');
  process.exit(2);
}
const url = `https://api.cloudflare.com/client/v4${path.replace('{account}', account).replace('{worker}', worker ?? '')}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
