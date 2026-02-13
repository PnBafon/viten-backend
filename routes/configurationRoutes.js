const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const db = require('../db');
const storage = require('../storage');

const uploadsDir = path.join(storage.uploadsDir, 'logos');
if (!storage.useFtp && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Use memory storage when uploading to FTP so we can pass buffer to storage.saveFile
const multerStorage = storage.useFtp
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => { cb(null, uploadsDir); },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'logo-' + uniqueSuffix + path.extname(file.originalname));
      }
    });

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = allowedTypes.test(ext) && allowedTypes.test(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed!'));
  }
});

function initializeConfigTable() {
  const createSql = `CREATE TABLE IF NOT EXISTS configuration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    app_name VARCHAR(255) DEFAULT 'Shop Accountant',
    logo_path TEXT DEFAULT NULL,
    location TEXT DEFAULT NULL,
    items TEXT DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
  db.run(createSql, [], (err) => {
    if (err) {
      console.error('Error creating configuration table:', err.message);
      return;
    }
    db.all("SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'configuration'", [], (err, rows) => {
      if (err) return;
      const columns = (rows || []).map(row => row.name);
      if (!columns.includes('location')) {
        db.run('ALTER TABLE configuration ADD COLUMN location TEXT DEFAULT NULL', []);
      }
      if (!columns.includes('items')) {
        db.run('ALTER TABLE configuration ADD COLUMN items TEXT DEFAULT NULL', []);
      }
      db.get('SELECT id FROM configuration WHERE id = 1', [], (err, row) => {
        if (!err && !row) {
          db.run('INSERT INTO configuration (id, app_name) VALUES (1, ?)', ['Shop Accountant'], () => {});
        }
      });
    });
  });
}

initializeConfigTable();

router.get('/', (req, res) => {
  db.get('SELECT app_name, logo_path, location, items FROM configuration WHERE id = 1', [], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    const config = {
      app_name: row?.app_name || 'Shop Accountant',
      logo_path: row?.logo_path || null,
      location: row?.location || null,
      items: row?.items ? JSON.parse(row.items) : []
    };
    if (config.logo_path) {
      config.logo_url = storage.resolveLogoUrl(config.logo_path);
    }
    res.json({ success: true, configuration: config });
  });
});

router.put('/app-name', (req, res) => {
  const { app_name } = req.body;
  if (!app_name || app_name.trim() === '') {
    return res.status(400).json({ success: false, message: 'App name is required' });
  }
  db.run(
    'UPDATE configuration SET app_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [app_name.trim()],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: 'Error updating app name' });
      res.json({ success: true, message: 'App name updated successfully' });
    }
  );
});

router.post('/logo', upload.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const buffer = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
  if (!buffer) return res.status(400).json({ success: false, message: 'No file data' });
  const filename = req.file.filename || 'logo-' + Date.now() + path.extname(req.file.originalname || '.png');
  const relativePath = 'logos/' + filename;

  db.get('SELECT logo_path FROM configuration WHERE id = 1', [], async (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    const oldPath = row && row.logo_path;
    storage.deleteFile(oldPath);

    try {
      const { path: storedPath, publicUrl } = await storage.saveFile(buffer, relativePath);
      db.run(
        'UPDATE configuration SET logo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
        [storedPath],
        function(updateErr) {
          if (updateErr) {
            storage.deleteFile(storedPath);
            return res.status(500).json({ success: false, message: 'Error updating logo' });
          }
          res.json({
            success: true,
            message: 'Logo uploaded successfully',
            logo_url: storage.resolveLogoUrl(storedPath)
          });
        }
      );
    } catch (e) {
      return res.status(500).json({ success: false, message: 'Upload failed: ' + e.message });
    }
  });
});

router.get('/logo/:filename', (req, res) => {
  const filename = req.params.filename;
  db.get('SELECT logo_path FROM configuration WHERE id = 1', [], (err, row) => {
    if (err || !row || !row.logo_path) {
      return res.status(404).json({ success: false, message: 'Logo not found' });
    }
    const stored = row.logo_path;
    if (storage.isRemoteUrl(stored)) {
      return res.redirect(stored);
    }
    const localPath = storage.getLocalPath(stored) || path.join(uploadsDir, filename);
    if (fs.existsSync(localPath)) {
      return res.sendFile(path.resolve(localPath));
    }
    res.status(404).json({ success: false, message: 'Logo not found' });
  });
});

router.put('/location', (req, res) => {
  const { location } = req.body;
  db.run(
    'UPDATE configuration SET location = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [location || null],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: 'Error updating location' });
      res.json({ success: true, message: 'Location updated successfully' });
    }
  );
});

router.put('/items', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'Items must be an array' });
  }
  if (items.length > 7) {
    return res.status(400).json({ success: false, message: 'Maximum 7 items allowed' });
  }
  const validItems = items.filter(item => typeof item === 'string' && item.trim() !== '');
  const itemsJson = JSON.stringify(validItems);
  db.run(
    'UPDATE configuration SET items = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [itemsJson],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: 'Error updating items' });
      res.json({ success: true, message: 'Items updated successfully' });
    }
  );
});

module.exports = router;
