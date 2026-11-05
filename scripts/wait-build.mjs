#!/usr/bin/env node
// Waits for the Workers Builds run of a commit and prints its outcome and the deployed commit.
// Usage: scripts/with-cf-env.sh node scripts/wait-build.mjs <commit-sha> [script-tag]
const [sha, tag = '028bd342095f4d42bb7111e4aa0a3d56'] = process.argv.slice(2);
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, APP_PUBLIC_URL: publicUrl } = process.env;
const headers = { Authorization: `Bearer ${token}` };
const deadline = Date.now() + 10 * 60_000;

while (Date.now() < deadline) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/builds/workers/${tag}/builds?per_page=10`, { headers });
  const data = await res.json();
  const builds = data.result ?? [];
  const build = builds.find((b) => (b.build_trigger_metadata?.commit_hash ?? '').startsWith(sha));
  if (build) {
    console.log(`build ${build.build_uuid} status=${build.status} outcome=${build.build_outcome ?? 'pending'}`);
    if (build.status === 'stopped' || build.build_outcome) {
      const health = await fetch(`${publicUrl}/api/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
      console.log('health', JSON.stringify(health));
      process.exit(build.build_outcome === 'success' ? 0 : 1);
    }
  } else {
    console.log(`no build yet for ${sha} (http ${res.status})`);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log('timed out waiting for the build');
process.exit(2);
