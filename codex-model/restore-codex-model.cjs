// Restore only this patch's exact files. Later edits/upgrades are never overwritten.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const backupDir = process.argv[2];
if (!backupDir) throw new Error('Usage: node restore-codex-model.cjs BACKUP_DIRECTORY [--dry-run]');
const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported backup manifest');
const approvedFiles = new Set([
  path.resolve(manifest.routerRoot, 'AuraChatTap.mjs').toLowerCase(),
  path.resolve(manifest.appRoot, 'next', 'aura-codex-bridge.mjs').toLowerCase(),
  path.resolve(manifest.appRoot, 'next', 'AuraCodexAppServer.mjs').toLowerCase(),
]);
for (const e of manifest.files) {
  const target = path.resolve(e.path);
  const catalogDir = path.resolve(manifest.appRoot, 'next', '.next', 'static', 'chunks');
  if (!approvedFiles.has(target.toLowerCase()) &&
      !(path.dirname(target).toLowerCase() === catalogDir.toLowerCase() && /^6927-.*\.js$/.test(path.basename(target)))) {
    throw new Error('Backup names an unexpected target: ' + target);
  }
  if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== e.installedSha256) {
    throw new Error('File changed since installation; inspect before restoring: ' + target);
  }
  if (e.existed) {
    if (path.basename(e.backupName) !== e.backupName) throw new Error('Invalid backup member path');
    if (hash(fs.readFileSync(path.join(backupDir, e.backupName))) !== e.sha256) throw new Error('Backup hash mismatch: ' + target);
  }
}
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ dryRun: true, files: manifest.files.map(e => e.path) }, null, 2));
} else {
  const snapshotDir = path.join(path.dirname(path.resolve(backupDir)), 'Before-Codex-Restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(snapshotDir, { recursive: true });
  for (const [i, e] of manifest.files.entries()) fs.copyFileSync(e.path, path.join(snapshotDir, `${i}-${path.basename(e.path)}`));
  fs.writeFileSync(path.join(snapshotDir, 'restored-from.json'), JSON.stringify({ backupDir: path.resolve(backupDir), files: manifest.files }, null, 2));
  for (const e of manifest.files) {
    const mode = fs.statSync(e.path).mode;
    fs.chmodSync(e.path, 0o666);
    if (e.existed) {
      try { fs.copyFileSync(path.join(backupDir, e.backupName), e.path); }
      finally { fs.chmodSync(e.path, mode); }
    } else fs.unlinkSync(e.path);
  }
  console.log(JSON.stringify({ restored: manifest.files.map(e => e.path), beforeRestoreBackup: snapshotDir }, null, 2));
}
