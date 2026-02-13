/**
 * Single source of truth for database and uploads base directory.
 * Used by server.js and all route files so packaged/Tauri app uses writable AppData.
 * SHOP_ACCOUNTANT_DATA_DIR: set by Tauri when running as desktop app.
 */
const path = require('path');

const isPackaged = typeof process.pkg !== 'undefined';
const dataDirEnv = process.env.SHOP_ACCOUNTANT_DATA_DIR;

function getBaseDir() {
  if (dataDirEnv) {
    return path.resolve(dataDirEnv);
  }
  if (isPackaged) {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname);
}

module.exports = { getBaseDir };
