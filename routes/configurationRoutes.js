const express = require('express');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');
const storage = require('../storage');

const ADMIN_USERNAME = 'admin1234';

const uploadsDir = path.join(storage.uploadsDir, 'logos');
if (!storage.useFtp && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

console.log('[Config Routes Init] useFtp:', storage.useFtp);
console.log('[Config Routes Init] uploadsDir:', uploadsDir);
console.log('[Config Routes Init] uploadsDir exists:', fs.existsSync(uploadsDir));

// Use memory storage when uploading to FTP so we can pass buffer to storage.saveFile
const multerStorage = storage.useFtp
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        console.log(`[Multer dest] uploadsDir exists: ${fs.existsSync(uploadsDir)}`);
        if (!fs.existsSync(uploadsDir)) {
          console.log(`[Multer dest] Creating directory: ${uploadsDir}`);
          try {
            fs.mkdirSync(uploadsDir, { recursive: true });
            console.log(`[Multer dest] Directory created successfully`);
          } catch (err) {
            console.error(`[Multer dest] Failed to create directory:`, err);
            return cb(err);
          }
        }
        console.log(`[Multer dest] Setting destination to: ${uploadsDir}`);
        cb(null, uploadsDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const newFilename = 'logo-' + uniqueSuffix + path.extname(file.originalname);
        console.log(`[Multer filename] Generated: ${newFilename}`);
        cb(null, newFilename);
      }
    });

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    console.log(`[Multer fileFilter] File received - fieldname: ${file.fieldname}, originalname: ${file.originalname}, mimetype: ${file.mimetype}`);
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const ext = path.extname(file.originalname).toLowerCase().replace(/^\./, ''); // remove leading dot
    const mimetype = file.mimetype || '';
    console.log(`[Multer fileFilter] ext=${ext}, mimetype=${mimetype}`);
    const ok = allowedTypes.test(ext) && allowedTypes.test(mimetype);
    console.log(`[Multer fileFilter] Validation result: ok=${ok}`);
    if (ok) {
      console.log(`[Multer fileFilter] File ACCEPTED`);
      cb(null, true);
    } else {
      const err = new Error('Only image files are allowed!');
      console.log(`[Multer fileFilter] File REJECTED:`, err.message);
      cb(err);
    }
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
        db.run('ALTER TABLE configuration ADD COLUMN location TEXT DEFAULT NULL', [], () => {});
      }
      if (!columns.includes('items')) {
        db.run('ALTER TABLE configuration ADD COLUMN items TEXT DEFAULT NULL', [], () => {});
      }
      if (!columns.includes('goal_pin_hash')) {
        db.run('ALTER TABLE configuration ADD COLUMN goal_pin_hash TEXT DEFAULT NULL', [], () => {});
      }
      if (!columns.includes('receipt_thank_you_message')) {
        db.run('ALTER TABLE configuration ADD COLUMN receipt_thank_you_message TEXT DEFAULT NULL', [], () => {});
      }
      if (!columns.includes('receipt_items_received_message')) {
        db.run('ALTER TABLE configuration ADD COLUMN receipt_items_received_message TEXT DEFAULT NULL', [], () => {});
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
  db.get('SELECT app_name, logo_path, location, items, receipt_thank_you_message, receipt_items_received_message FROM configuration WHERE id = 1', [], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    const config = {
      app_name: row?.app_name || 'Shop Accountant',
      logo_path: row?.logo_path || null,
      location: row?.location || null,
      items: row?.items ? JSON.parse(row.items) : [],
      receipt_thank_you_message: row?.receipt_thank_you_message != null && row.receipt_thank_you_message !== ''
        ? row.receipt_thank_you_message
        : 'Thank you for your business',
      receipt_items_received_message: row?.receipt_items_received_message != null && row.receipt_items_received_message !== ''
        ? row.receipt_items_received_message
        : '{customer} received the above items in good condition.'
    };
    if (config.logo_path) {
      // Return the actual URL: FTP URL for remote, or local API path for local files
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

// Multer middleware with error handling wrapper
const logoUploadMiddleware = (req, res, next) => {
  console.log('[Logo middleware] Invoking multer...');
  upload.single('logo')(req, res, (err) => {
    if (err) {
      console.error('[Logo middleware] Multer error:', err.message);
      return res.status(400).json({ success: false, message: 'Upload error: ' + err.message });
    }
    console.log('[Logo middleware] Multer completed, req.file:', req.file ? 'present' : 'NULL');
    next();
  });
};

router.post('/logo', logoUploadMiddleware, async (req, res) => {
  try {
    console.log('[Logo POST] Handler invoked');
    console.log('[Logo POST] storage.useFtp:', storage.useFtp);
    
    if (!req.file) {
      console.warn('[Logo POST] req.file is NULL');
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    console.log('[Logo POST] req.file properties:', {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      encoding: req.file.encoding,
      mimetype: req.file.mimetype,
      size: req.file.size,
      destination: req.file.destination || 'N/A (using memory)',
      filename: req.file.filename || 'N/A (using memory)',
      pathExists: !!req.file.path,
      bufferExists: !!req.file.buffer,
      bufferLength: req.file.buffer ? req.file.buffer.length : 'N/A'
    });

    const buffer = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
    if (!buffer) {
      console.error('[Logo POST] No buffer available');
      return res.status(400).json({ success: false, message: 'Failed to read file data' });
    }

    console.log(`[Logo POST] Ready to save: ${buffer.length} bytes`);
    const filename = 'logo-' + Date.now() + path.extname(req.file.originalname || '.png');
    const relativePath = 'logos/' + filename;

    db.get('SELECT logo_path FROM configuration WHERE id = 1', [], async (err, row) => {
      if (err) {
        console.error('[Logo POST] DB select error:', err);
        return res.status(500).json({ success: false, message: 'Database error' });
      }

      const oldPath = row && row.logo_path;
      if (oldPath) {
        console.log('[Logo POST] Deleting old logo:', oldPath);
        storage.deleteFile(oldPath);
      }

      try {
        console.log('[Logo POST] Saving to storage...');
        const { path: storedPath, publicUrl } = await storage.saveFile(buffer, relativePath);
        console.log('[Logo POST] Saved successfully:', { storedPath, publicUrl });
        
        db.run(
          'UPDATE configuration SET logo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
          [storedPath],
          function(updateErr) {
            if (updateErr) {
              console.error('[Logo POST] DB update error:', updateErr);
              storage.deleteFile(storedPath);
              return res.status(500).json({ success: false, message: 'Failed to save logo' });
            }
            console.log('[Logo POST] DB updated, responding with success');
            res.json({
              success: true,
              message: 'Logo uploaded successfully',
              logo_url: storage.resolveLogoUrl(storedPath)
            });
          }
        );
      } catch (e) {
        console.error('[Logo POST] Storage save error:', e);
        return res.status(500).json({ success: false, message: 'Upload failed: ' + e.message });
      }
    });
  } catch (error) {
    console.error('[Logo POST] Handler error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete logo
router.delete('/logo', (req, res) => {
  try {
    db.get('SELECT logo_path FROM configuration WHERE id = 1', [], (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }

      if (!row || !row.logo_path) {
        return res.status(400).json({ success: false, message: 'No logo to delete' });
      }

      const oldPath = row.logo_path;
      storage.deleteFile(oldPath);

      db.run(
        'UPDATE configuration SET logo_path = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
        [],
        function(updateErr) {
          if (updateErr) {
            return res.status(500).json({ success: false, message: 'Failed to delete logo' });
          }
          res.json({ success: true, message: 'Logo deleted successfully' });
        }
      );
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
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

// Proxy route for logo - streams from remote (FTP) or local, avoids CORS/hotlink issues
router.get('/logo-image', (req, res) => {
  db.get('SELECT logo_path FROM configuration WHERE id = 1', [], async (err, row) => {
    if (err || !row || !row.logo_path) {
      return res.status(404).json({ success: false, message: 'Logo not found' });
    }
    const stored = row.logo_path;
    if (storage.isRemoteUrl(stored)) {
      try {
        const resp = await fetch(stored, { headers: { 'Accept': 'image/*' } });
        if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
        res.set('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
        Readable.fromWeb(resp.body).pipe(res);
      } catch (e) {
        console.error('[Logo proxy] Fetch error:', e.message);
        return res.status(502).json({ success: false, message: 'Failed to load logo' });
      }
      return;
    }
    const localPath = storage.getLocalPath(stored);
    if (localPath && fs.existsSync(localPath)) {
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

router.put('/receipt-thank-you', (req, res) => {
  const { receipt_thank_you_message } = req.body;
  const value = typeof receipt_thank_you_message === 'string' ? receipt_thank_you_message.trim() : null;
  db.run(
    'UPDATE configuration SET receipt_thank_you_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [value || null],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: 'Error updating receipt thank-you message' });
      res.json({ success: true, message: 'Thank-you message updated successfully' });
    }
  );
});

router.put('/receipt-items-received', (req, res) => {
  const { receipt_items_received_message } = req.body;
  const value = typeof receipt_items_received_message === 'string' ? receipt_items_received_message.trim() : null;
  db.run(
    'UPDATE configuration SET receipt_items_received_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [value || null],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: 'Error updating items-received message' });
      res.json({ success: true, message: 'Items-received message updated successfully' });
    }
  );
});

// --- PIN settings (Goal component). Set/update is admin-only. ---

router.get('/pin/goal', (req, res) => {
  db.get('SELECT goal_pin_hash FROM configuration WHERE id = 1', [], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    const hasPin = !!(row && row.goal_pin_hash);
    res.json({ success: true, hasPin });
  });
});

router.put('/pin/goal', (req, res) => {
  const username = req.headers['x-user-username'] || req.body.username;
  if (!username || username !== ADMIN_USERNAME) {
    return res.status(403).json({ success: false, message: 'Only admin can set or change the Goal PIN' });
  }
  db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (!user) return res.status(403).json({ success: false, message: 'User not found' });

    const { pin } = req.body;
    if (pin === null || pin === undefined || pin === '') {
      db.run(
        'UPDATE configuration SET goal_pin_hash = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
        [],
        function(runErr) {
          if (runErr) return res.status(500).json({ success: false, message: 'Error clearing PIN' });
          res.json({ success: true, message: 'Goal PIN removed' });
        }
      );
      return;
    }
    const pinStr = String(pin).trim();
    if (pinStr.length < 4) {
      return res.status(400).json({ success: false, message: 'PIN must be at least 4 characters' });
    }
    const hash = bcrypt.hashSync(pinStr, 10);
    db.run(
      'UPDATE configuration SET goal_pin_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [hash],
      function(runErr) {
        if (runErr) return res.status(500).json({ success: false, message: 'Error saving PIN' });
        res.json({ success: true, message: 'Goal PIN set successfully' });
      }
    );
  });
});

router.post('/pin/verify-goal', (req, res) => {
  const { pin } = req.body;
  if (pin === undefined || pin === null) {
    return res.status(400).json({ success: false, valid: false, message: 'PIN required' });
  }
  db.get('SELECT goal_pin_hash FROM configuration WHERE id = 1', [], (err, row) => {
    if (err) return res.status(500).json({ success: false, valid: false, message: 'Database error' });
    if (!row || !row.goal_pin_hash) {
      return res.json({ success: true, valid: true });
    }
    const valid = bcrypt.compareSync(String(pin), row.goal_pin_hash);
    res.json({ success: true, valid });
  });
});

module.exports = router;
