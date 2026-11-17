import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function prBuddyEntry() {
  const configured = process.env.PRBUDDY_JS_ENTRY;
  const entry = configured !== undefined ? path.resolve(configured) :
    fileURLToPath(new URL('../../pr-buddy-js/bin/prbuddy.mjs', import.meta.url));
  return fs.statSync(entry, { throwIfNoEntry: false })?.isFile() ? entry : null;
}

export function reviewChanges(root, base) {
  const entry = prBuddyEntry();
  if (!entry) {
    throw new Error('What changed needs PR Buddy JS. Install a sibling pr-buddy-js checkout or set PRBUDDY_JS_ENTRY to its bin/prbuddy.mjs.');
  }
  const args = [entry, '--repo', root, '--uncommitted', '--json'];
  if (base) args.push('--', base);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw new Error('Could not run PR Buddy JS: ' + result.error.message);
  // Exit 1 means a configured threshold was reached. The report is complete.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error('PR Buddy JS: ' + (result.stderr.trim() || 'review did not complete.'));
  }
  return JSON.parse(result.stdout);
}
