#!/usr/bin/env node
// Prints a password hash in the application's format. Used to produce the bootstrap
// administrator hash in the initial migration. Reads the password from stdin.
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
const [N, r, p] = [32768, 8, 1];
const salt = randomBytes(16);
const hash = scryptSync(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`);
