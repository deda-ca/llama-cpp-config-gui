/**
 * Self-update: check GitHub Releases for a newer version and (in release mode)
 * download + replace the running executable.
 *
 * The release workflow uploads a zip asset named
 * `llama-cpp-config-gui-v<version>-<platform>-<arch>.zip` containing the single
 * binary. We match the asset for the current platform, download it, extract it
 * next to the running executable, and swap it in (the old binary is moved aside
 * first, which is required on Windows where a running exe cannot be overwritten).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

export const REPO_OWNER = 'deda-ca';
export const REPO_NAME = 'llama-cpp-config-gui';
export const RELEASE_PAGE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

export interface UpdateCheck {
  current: string;
  latest: string;
  /** true when `latest` is newer than `current` */
  available: boolean;
  releaseUrl: string;
  /** Asset matching this platform, when a newer release has one */
  assetName: string | null;
  assetUrl: string | null;
  publishedAt: string | null;
}

export interface UpdateApplyResult {
  latest: string;
  /** Path of the replaced executable */
  targetPath: string;
  /** Path the previous executable was kept at, suffixed with its version ("" when removed) */
  backupPath: string;
}

/** Asset name suffix for the current platform, matching release.yml naming. */
export function platformAssetSuffix(): string {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${platform}-${arch}`;
}

/** Compare dotted semver-ish strings; returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function stripV(tag: string): string {
  return tag.replace(/^v/, '');
}

/**
 * Fetch the latest GitHub release and compare against `current`.
 * Throws on network/API failure (caller turns that into a 502).
 */
export async function checkForUpdate(current: string): Promise<UpdateCheck> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `${REPO_NAME}/${current}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}`);
  }
  const rel = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    published_at?: string;
    assets?: { name?: string; browser_download_url?: string }[];
  };
  const latest = stripV(rel.tag_name ?? '');
  if (!latest) throw new Error('release response missing tag_name');

  const available = compareVersions(latest, current) > 0;
  const suffix = platformAssetSuffix();
  const asset = (rel.assets ?? []).find((a) => a.name?.includes(suffix) && a.browser_download_url);

  return {
    current,
    latest,
    available,
    releaseUrl: rel.html_url || `${RELEASE_PAGE_URL}/tag/v${latest}`,
    assetName: available && asset?.name ? asset.name : null,
    assetUrl: available && asset?.browser_download_url ? asset.browser_download_url : null,
    publishedAt: rel.published_at ?? null,
  };
}

/** Run a CLI (unzip/tar), rejecting on spawn failure or non-zero exit. */
function runTool(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', () => reject(new Error(`${cmd} is not available on this system`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/** Extract a zip archive into `destDir` using an available system tool. */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    // PowerShell is present on every supported Windows version.
    await runTool('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
    return;
  }
  try {
    await runTool('unzip', ['-o', zipPath, '-d', destDir]);
  } catch {
    // Fall back to bsdtar (ships with macOS, available on many Linux distros).
    await runTool('tar', ['-xf', zipPath, '-C', destDir]);
  }
}

/**
 * Download the release asset and replace the running executable.
 * `binaryName` is the executable to look for inside the archive
 * (e.g. "llama-cpp-config-gui" or "...exe" on Windows).
 * `targetPath` must be the path of the currently running binary.
 */
export async function applyUpdate(
  check: UpdateCheck,
  targetPath: string,
  binaryName: string,
): Promise<UpdateApplyResult> {
  if (!check.assetUrl || !check.assetName) {
    throw new Error(`No release asset found for platform ${platformAssetSuffix()}`);
  }

  const res = await fetch(check.assetUrl, {
    headers: { 'User-Agent': `${REPO_NAME}/${check.current}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-gui-update-'));
  try {
    const zipPath = path.join(tmpDir, check.assetName);
    fs.writeFileSync(zipPath, buf);
    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(extractDir);
    await extractZip(zipPath, extractDir);

    // Locate the extracted binary (top level, or one directory deep).
    let newBin = path.join(extractDir, binaryName);
    if (!fs.existsSync(newBin)) {
      const entries = fs.readdirSync(extractDir, { withFileTypes: true });
      const sub = entries.find((e) => e.isDirectory() && fs.existsSync(path.join(extractDir, e.name, binaryName)));
      if (sub) newBin = path.join(extractDir, sub.name, binaryName);
    }
    if (!fs.existsSync(newBin)) {
      throw new Error(`archive does not contain ${binaryName}`);
    }

    // Swap atomically-ish: move the running binary aside under a name carrying
    // the version it was (e.g. "llama-cpp-config-gui.v0.7.0"), then install the
    // new one. The backup doubles as a manual rollback copy; the version is
    // known because APP_VERSION is baked into the running binary at build time.
    const backupPath = `${targetPath}.v${check.current}`;
    try {
      fs.renameSync(targetPath, backupPath);
    } catch (e) {
      throw new Error(`cannot move current binary aside: ${(e as Error).message}`);
    }
    try {
      fs.copyFileSync(newBin, targetPath);
      fs.chmodSync(targetPath, 0o755);
    } catch (e) {
      // Roll back so the install is never left without a binary.
      fs.renameSync(backupPath, targetPath);
      throw new Error(`cannot install new binary: ${(e as Error).message}`);
    }

    // Keep the versioned backup for rollback, but drop older ones so the
    // directory does not accumulate binaries. On Windows the just-replaced
    // process image may still be locked — unlink is best-effort there.
    const keptBackup = backupPath;
    try {
      const dir = path.dirname(targetPath);
      const base = path.basename(targetPath);
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`${base}.v`) && entry !== backupPath) {
          try {
            fs.unlinkSync(path.join(dir, entry));
          } catch {
            /* locked or already gone */
          }
        }
      }
    } catch {
      /* listing failed; nothing to clean */
    }

    return { latest: check.latest, targetPath, backupPath: keptBackup };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
