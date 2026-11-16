#!/usr/bin/env node
/**
 * Fail if a tracked text file looks like it contains a credential or a private deployment detail.
 *
 * This is a guard rail, not a proof: it matches common key formats and assignment shapes. A human
 * must still review the diff, and a secret that has already been committed must be rotated even if
 * this script is later made to pass.
 *
 * Usage: node scripts/check-secrets.mjs
 *
 * Scans the current tree: tracked files plus untracked, non-ignored files. That also works before
 * the first commit and catches a stray file before `git add`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
}).split('\0').filter(Boolean);

// Files that legitimately contain hash-like or key-like strings.
const SKIP = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

const RULES = [
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'AWS access key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'GitHub token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  },
  {
    name: 'OpenAI-style key',
    re: /\bsk-[A-Za-z0-9_-]{24,}\b/,
  },
  {
    name: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{30,}\b/,
  },
  {
    name: 'Slack token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    name: 'credential in URL',
    re: /https?:\/\/[^\s/:@]+:[^\s/@]+@/,
  },
  {
    name: 'workspace magic link',
    re: /\?workspace=[A-Za-z0-9_-]{16,}\b/,
  },
  {
    name: 'quoted secret assignment',
    // Matches password/token/secret/apiKey = "long value", but not short test fixtures.
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'`]([^"'`\n]{16,})["'`]/i,
    // Placeholders and obvious examples are fine.
    allow: (value) => /^(?:<[^>]+>|\$\{[^}]+\}|\.{3}|example|placeholder|changeme|test[-_ ]?only)/i.test(value),
  },
];

const suspiciousPaths = /(^|\/)(?:\.env(?:\.|$)|\.netrc$|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key)$|credentials(?:\.|$)|secrets?(?:\.|$))/i;

const problems = [];

for (const file of files) {
  if (SKIP.has(file)) continue;
  if (suspiciousPaths.test(file)) {
    problems.push(`${file}: suspicious file name (credentials/keys are not committed)`);
    continue;
  }
  let text;
  try {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    if (buf.length > 4 * 1024 * 1024) continue;
    text = buf.toString('utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000) continue;
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
      let m;
      while ((m = re.exec(line))) {
        if (rule.allow && rule.allow(m[1] ?? '')) continue;
        problems.push(`${file}:${i + 1}: ${rule.name}`);
        break;
      }
    }
  }
}

if (problems.length) {
  console.error('✗ Potential secrets or private access details found in tracked files:');
  for (const p of problems) console.error('  ' + p);
  console.error('\nRemove/rotate them before committing. If this is a false positive, narrow the rule.');
  process.exit(1);
}

console.log(`✓ check-secrets: scanned ${files.length} tracked files, no known credential patterns found.`);
