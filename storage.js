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
// FTP_PUBLIC_BASE_URL or FTP_BASE_URL must be set when using FTP (e.g. https://yoursite.com/files)
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
    const client = new Client(60000); // 60s timeout
    try {
      console.log('FTP Config:', {
        host: ftpConfig.host,
        port: ftpConfig.port,
        user: ftpConfig.user,
        secure: ftpConfig.secure
      });
      console.log('Connecting to FTP server...');
      await client.access(ftpConfig);
      console.log('Connected to FTP server');
      
      const remotePath = path.posix.join(ftpBaseDir, normalized);
      console.log('Remote path:', remotePath);
      
      const dir = path.posix.dirname(remotePath);
      console.log('Ensuring directory:', dir);
      await client.ensureDir(dir);
      
      console.log('Uploading file, size:', buffer.length, 'bytes');
      await client.uploadFrom(Readable.from(Buffer.from(buffer)), remotePath);
      console.log('File uploaded successfully');
      
      // Public URL must match the actual path on the server (include ftpBaseDir e.g. /viten-shop)
      const pathForUrl = remotePath.replace(/^\/+/, '');
      const publicUrl = ftpPublicBaseUrl ? `${ftpPublicBaseUrl}/${pathForUrl}` : remotePath;
      console.log('Public URL:', publicUrl);
      return { path: publicUrl, publicUrl };
    } catch (ftpErr) {
      console.error('FTP error details:', {
        message: ftpErr.message,
        code: ftpErr.code,
        status: ftpErr.status,
        stack: ftpErr.stack
      });
      throw ftpErr;
    } finally {
      try {
        client.close();
      } catch (e) {
        console.warn('Error closing FTP connection:', e.message);
      }
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
    ensureLocalDir(path.join(uploadsDir, 'purchases'));
  }
};
