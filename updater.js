'use strict';
// Self-update from GitHub.
//   * update.json (next to this file) says which repository and branch hold the public version.
//   * Checking  = read package.json (version) and CHANGELOG.md from raw.githubusercontent.com.
//   * Updating  = download the branch as a ZIP from codeload.github.com, back up the current files,
//                 copy the new ones over (never node_modules, never the user's data), run `npm install`
//                 only if the dependencies changed, and restart.
// Publishing an update is therefore just: bump "version" in package.json and push to the branch.
// User data (profiles, passwords, settings) lives in %APPDATA%\BoomBangLauncher and is never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', '.github', 'docs']);   // never copied from / backed up
const MAX_ZIP = 60 * 1024 * 1024;

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
function validRepo(repo) { return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.includes('..'); }
function validBranch(b) { return typeof b === 'string' && /^[A-Za-z0-9._\/-]{1,100}$/.test(b) && !b.includes('..'); }

// Notes of the newest section of CHANGELOG.md ("## x.y.z" ... until the next "## ").
function notesFor(changelog, version) {
  const text = String(changelog || '');
  const re = /^##\s+v?(\d+\.\d+\.\d+)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm;
  let m, first = null;
  while ((m = re.exec(text))) {
    const block = m[2].trim();
    if (!first) first = block;
    if (version && m[1] === String(version).replace(/^v/i, '')) return block;
  }
  return first || '';
}

function readConfig(appDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(appDir, 'update.json'), 'utf8'));
    const repo = String(cfg.repo || '').trim(), branch = String(cfg.branch || 'main').trim();
    if (!validRepo(repo) || /^OWNER\//i.test(repo) || !validBranch(branch)) return null;
    return { repo, branch };
  } catch (_) { return null; }
}

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dir === base && SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}
function copyFiles(fromDir, toDir, files) {
  for (const rel of files) {
    const dest = path.join(toDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(fromDir, rel), dest);
  }
}
function depsOf(pkg) { return JSON.stringify({ d: pkg.dependencies || {}, dd: pkg.devDependencies || {} }); }

/**
 * opts:
 *   appDir         folder of the launcher (where package.json lives)
 *   dataDir        user data folder (backups go here)
 *   currentVersion version running now
 *   getBuffer(url) -> Promise<Buffer>  (HTTPS GET, follows redirects)
 *   extract(zip, destDir) -> Promise   (unzip)
 *   npmInstall(appDir) -> Promise<{ok,message}>
 */
function createUpdater(opts) {
  const appDir = opts.appDir;
  const raw = (cfg, file) => `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${file}`;
  const zipUrl = cfg => `https://codeload.github.com/${cfg.repo}/zip/refs/heads/${cfg.branch}`;
  let busy = false;

  async function check() {
    const cfg = readConfig(appDir);
    if (!cfg) return { ok: false, configured: false, current: opts.currentVersion, message: 'Las actualizaciones aún no están configuradas.' };
    try {
      const pkg = JSON.parse((await opts.getBuffer(raw(cfg, 'package.json') + `?t=${Date.now()}`)).toString('utf8'));
      const latest = String(pkg.version || '');
      if (!parseVersion(latest)) return { ok: false, configured: true, current: opts.currentVersion, message: 'La versión publicada no es válida.' };
      let notes = '';
      try { notes = notesFor((await opts.getBuffer(raw(cfg, 'CHANGELOG.md') + `?t=${Date.now()}`)).toString('utf8'), latest); } catch (_) {}
      return { ok: true, configured: true, repo: cfg.repo, current: opts.currentVersion, latest, available: isNewer(latest, opts.currentVersion), notes };
    } catch (error) {
      return { ok: false, configured: true, current: opts.currentVersion, message: `No se pudo comprobar (${error && error.message || error}).` };
    }
  }

  async function apply(progress = () => {}) {
    if (busy) return { ok: false, message: 'Ya se está actualizando.' };
    const cfg = readConfig(appDir);
    if (!cfg) return { ok: false, message: 'Las actualizaciones no están configuradas.' };
    busy = true;
    const work = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), 'bb-update-'));
    const backup = path.join(opts.dataDir, 'update-backup');
    let copied = false, oldFiles = [];
    try {
      progress('Descargando…');
      const zip = await opts.getBuffer(zipUrl(cfg));
      if (!zip || zip.length < 100 || zip.length > MAX_ZIP || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error('la descarga no es un ZIP válido');
      const zipFile = path.join(work, 'update.zip'); fs.writeFileSync(zipFile, zip);
      progress('Descomprimiendo…');
      const out = path.join(work, 'x'); fs.mkdirSync(out);
      await opts.extract(zipFile, out);
      // GitHub puts everything inside one folder ("repo-branch/")
      const tops = fs.readdirSync(out, { withFileTypes: true });
      const root = tops.length === 1 && tops[0].isDirectory() ? path.join(out, tops[0].name) : out;
      const newPkgFile = path.join(root, 'package.json');
      if (!fs.existsSync(newPkgFile) || !fs.existsSync(path.join(root, 'main.js'))) throw new Error('el paquete descargado no es el launcher');
      const newPkg = JSON.parse(fs.readFileSync(newPkgFile, 'utf8'));
      const curPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      if (newPkg.name !== curPkg.name) throw new Error('el repositorio no contiene este launcher');
      if (!isNewer(newPkg.version, opts.currentVersion)) throw new Error('ya tienes la última versión');

      progress('Guardando copia de seguridad…');
      fs.rmSync(backup, { recursive: true, force: true });
      oldFiles = listFiles(appDir);
      copyFiles(appDir, backup, oldFiles);

      progress('Instalando archivos nuevos…');
      const newFiles = listFiles(root);
      copied = true;
      copyFiles(root, appDir, newFiles);

      if (depsOf(newPkg) !== depsOf(curPkg)) {
        progress('Instalando dependencias (puede tardar)…');
        const r = await opts.npmInstall(appDir);
        if (!r || !r.ok) throw new Error(`npm install falló${r && r.message ? ': ' + r.message : ''}`);
      }
      progress('Listo. Reiniciando…');
      return { ok: true, version: newPkg.version };
    } catch (error) {
      if (copied) { try { copyFiles(backup, appDir, oldFiles); } catch (_) {} }   // put the old version back
      return { ok: false, message: `No se pudo actualizar: ${error && error.message || error}.`, restored: copied };
    } finally {
      busy = false;
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    }
  }

  return { check, apply, config: () => readConfig(appDir) };
}

module.exports = { createUpdater, isNewer, parseVersion, notesFor, readConfig, validRepo };
