#!/usr/bin/env node
// Writes dist/client/build.json so /api/health can report the deployed commit.
// Workers Builds sets WORKERS_CI_COMMIT_SHA; a local build falls back to `git rev-parse`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

function localCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const ci = process.env.WORKERS_CI_COMMIT_SHA;
const info = {
  commit: ci || localCommit(),
  source: ci ? 'workers-builds' : 'local',
  branch: process.env.WORKERS_CI_BRANCH ?? null,
  builtAt: new Date().toISOString(),
};
mkdirSync('dist/client', { recursive: true });
writeFileSync('dist/client/build.json', JSON.stringify(info, null, 2));
console.log('build info', info);
