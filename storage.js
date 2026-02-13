/**
 * File storage: FTP (production) or local disk.
 * Set FTP_HOST to use FTP for uploads; logos and backups use this.
 */
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { getBaseDir } = require('./dataPath');

const useFtp = !!process.env.FTP_HOST;
const baseDir = getBaseDir();
const uploadsDir = path.join(baseDir, 'uploads');

const ftpConfig = useFtp ? {
  host: process.env.FTP_HOST,
  port: parseInt(process.env.FTP_PORT || '21', 10),
  user: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD,
  secure: process.env.FTP_SECURE === 'true'
} : null;

const ftpBaseDir = (process.env.FTP_BASE_DIR || '/').replace(/\/+$/, '') || '';
const ftpPublicBaseUrl = (process.env.FTP_PUBLIC_BASE_URL || process.env.FTP_BASE_URL || '').replace(/\/+$/, '');

function ensureLocalDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Save a file. buffer is a Buffer; relativePath e.g. "logos/logo-123.png".
 * Returns { path: string, publicUrl: string }.
 * path: value to store in DB (full URL if FTP, else local path).
 * publicUrl: URL to return to client for display.
 */
async function saveFile(buffer, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (useFtp && ftpConfig) {
    const Client = require('basic-ftp').Client;
    const client = new Client(undefined, ftpConfig.secure);
    try {
      await client.access(ftpConfig);
      const remotePath = path.posix.join(ftpBaseDir, normalized);
      const dir = path.posix.dirname(remotePath);
      await client.ensureDir(dir);
      await client.uploadFrom(Readable.from(Buffer.from(buffer)), remotePath);
      const publicUrl = ftpPublicBaseUrl ? `${ftpPublicBaseUrl}/${normalized}` : remotePath;
      return { path: publicUrl, publicUrl };
    } finally {
      client.close();
    }
  }
  const localPath = path.join(uploadsDir, normalized);
  ensureLocalDir(path.dirname(localPath));
  fs.writeFileSync(localPath, buffer);
  const publicUrl = `/api/uploads/${normalized}`;
  return { path: localPath, publicUrl };
}

/**
 * Resolve logo URL for API response. storedPath is either a full URL (FTP) or local path.
 */
function resolveLogoUrl(storedPath) {
  if (!storedPath) return null;
  if (storedPath.startsWith('http://') || storedPath.startsWith('https://')) return storedPath;
  const filename = path.basename(storedPath);
  return `/api/configuration/logo/${filename}`;
}

/**
 * Check if a path is a remote URL (FTP).
 */
function isRemoteUrl(storedPath) {
  return !!(storedPath && (storedPath.startsWith('http://') || storedPath.startsWith('https://')));
}

/**
 * Get full path for local file (for delete or sendFile). Returns null if remote.
 */
function getLocalPath(storedPath) {
  if (!storedPath || isRemoteUrl(storedPath)) return null;
  if (path.isAbsolute(storedPath)) return storedPath;
  return path.join(uploadsDir, path.basename(storedPath));
}

/**
 * Delete a file by stored path (local path or URL). For FTP we could delete by path; many FTP hosts don't support delete or we'd need path. For now we only delete local files.
 */
function deleteFile(storedPath) {
  const local = getLocalPath(storedPath);
  if (local && fs.existsSync(local)) fs.unlinkSync(local);
}

module.exports = {
  useFtp,
  uploadsDir,
  ftpPublicBaseUrl: useFtp ? ftpPublicBaseUrl : null,
  saveFile,
  resolveLogoUrl,
  isRemoteUrl,
  getLocalPath,
  deleteFile,
  ensureLocalDir: () => {
    ensureLocalDir(uploadsDir);
    ensureLocalDir(path.join(uploadsDir, 'backups'));
    ensureLocalDir(path.join(uploadsDir, 'logos'));
  }
};
