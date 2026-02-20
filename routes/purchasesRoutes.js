/**
 * Purchases (inventory) routes.
 * Image flow: on save with image selected → image is stored on FTP (or local);
 * the returned URL is saved in DB (image_path). API returns image_url = that
 * database URL; frontend uses image_url to display the image.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const multer = require('multer');
const router = express.Router();
const db = require('../db');
const storage = require('../storage');

const purchasesDir = path.join(storage.uploadsDir, 'purchases');
const backupsDir = path.join(storage.uploadsDir, 'backups');
if (!storage.useFtp) {
  if (!fs.existsSync(purchasesDir)) fs.mkdirSync(purchasesDir, { recursive: true });
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
}

const multerStorage = storage.useFtp
  ? multer.memoryStorage()
    : multer.diskStorage({
      destination: (req, file, cb) => { cb(null, purchasesDir); },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'purchase-' + uniqueSuffix + path.extname(file.originalname));
      }
    });

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/^\./, '');
    const mimetype = (file.mimetype || '').toLowerCase();
    const okByExt = ext && allowedTypes.test(ext);
    const okByMime = mimetype && (allowedTypes.test(mimetype) || mimetype.startsWith('image/'));
    const ok = Boolean(okByExt || okByMime);
    if (!ok) {
      console.log('[purchasesRoutes] fileFilter reject:', { originalname: file.originalname, mimetype: file.mimetype, ext });
    }
    cb(ok ? null : new Error('Only image files are allowed (JPEG, PNG, GIF, WebP)'));
  }
});

// Accept any file field so we always get the first file (browsers may send different field names)
const handleImageUpload = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'File upload error' });
    }
    next();
  });
};

// Single-file upload: accept any field name and use first file (avoids 400 when client sends multipart slightly differently)
const uploadSingleImage = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'File upload error' });
    }
    next();
  });
};

// Get all purchases records
router.get('/', (req, res) => {
  db.all(
    'SELECT * FROM purchases ORDER BY date DESC, created_at DESC',
    [],
    (err, records) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      // Frontend uses database URL to display: image_url is the value stored in image_path (FTP URL or local URL)
      const mapped = (records || []).map(r => {
        const rec = { ...r };
        if (rec.image_path) {
          if (storage.isRemoteUrl(rec.image_path)) {
            rec.image_url = rec.image_path; // FTP: use database URL as-is
          } else {
            const localPath = storage.getLocalPath(rec.image_path) || rec.image_path;
            try {
              const rel = path.relative(storage.uploadsDir, localPath).replace(/\\/g, '/');
              rec.image_url = rel.startsWith('..') ? `/api/purchases/asset/${rec.id}` : `/api/uploads/${rel}`;
            } catch (e) {
              rec.image_url = `/api/purchases/asset/${rec.id}`;
            }
          }
        } else {
          rec.image_url = null;
        }
        return rec;
      });
      res.json({ success: true, purchases: mapped });
    }
  );
});

// Image asset: same approach as logo – serve via API (stream from FTP or send local file)
router.get('/asset/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT image_path FROM purchases WHERE id = ?', [id], async (err, row) => {
    if (err || !row || !row.image_path) {
      return res.status(404).json({ success: false, message: 'Image not found' });
    }
    const stored = row.image_path;
    if (storage.isRemoteUrl(stored)) {
      try {
        const resp = await fetch(stored, { headers: { 'Accept': 'image/*' } });
        if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
        res.set('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
        Readable.fromWeb(resp.body).pipe(res);
      } catch (e) {
        console.error('[Purchases asset] Fetch error:', e.message);
        return res.status(502).json({ success: false, message: 'Failed to load image' });
      }
      return;
    }
    const localPath = storage.getLocalPath(stored);
    if (localPath && fs.existsSync(localPath)) {
      return res.sendFile(path.resolve(localPath));
    }
    res.status(404).json({ success: false, message: 'Image not found' });
  });
});

// Get single purchase record
router.get('/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    'SELECT * FROM purchases WHERE id = ?',
    [id],
    (err, record) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }

      if (!record) {
        return res.status(404).json({ success: false, message: 'Purchase record not found' });
      }

      if (record.image_path) {
        record.image_url = storage.isRemoteUrl(record.image_path) ? record.image_path : (() => {
          const localPath = storage.getLocalPath(record.image_path) || record.image_path;
          try {
            const rel = path.relative(storage.uploadsDir, localPath).replace(/\\/g, '/');
            return rel.startsWith('..') ? `/api/purchases/asset/${record.id}` : `/api/uploads/${rel}`;
          } catch (e) {
            return `/api/purchases/asset/${record.id}`;
          }
        })();
      } else {
        record.image_url = null;
      }
      res.json({ success: true, purchase: record });
    }
  );
});

// Upload/update item image only (same flow as logo: POST + single file → FTP/local → DB URL → return)
router.post('/:id/image', uploadSingleImage, async (req, res) => {
  const { id } = req.params;

  const fileList = Array.isArray(req.files) ? req.files : (req.files && typeof req.files === 'object' ? Object.values(req.files).flat() : []);
  const uploaded = fileList[0] || req.file || null;

  if (!uploaded) {
    return res.status(400).json({ success: false, message: 'No image file uploaded' });
  }

  const buffer = uploaded.buffer || (uploaded.path ? fs.readFileSync(uploaded.path) : null);
  if (!buffer) {
    return res.status(400).json({ success: false, message: 'Failed to read file data' });
  }

  db.get('SELECT * FROM purchases WHERE id = ?', [id], async (err, record) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (!record) return res.status(404).json({ success: false, message: 'Purchase record not found' });

    const oldPath = record.image_path;
    if (oldPath) {
      try { storage.deleteFile(oldPath); } catch (e) { /* ignore */ }
    }

    try {
      const filename = 'purchase-' + Date.now() + path.extname(uploaded.originalname || '.png');
      const relativePath = 'purchases/' + filename;
      const saved = await storage.saveFile(buffer, relativePath);
      const storedPath = saved.path;

      db.run(
        'UPDATE purchases SET image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [storedPath, id],
        function(updateErr) {
          if (updateErr) {
            try { storage.deleteFile(storedPath); } catch (e) { /* ignore */ }
            return res.status(500).json({ success: false, message: 'Failed to save image' });
          }
          db.get('SELECT * FROM purchases WHERE id = ?', [id], (err, updatedRecord) => {
            if (err) return res.status(500).json({ success: false, message: 'Database error' });
            updatedRecord.image_url = updatedRecord && updatedRecord.image_path
              ? (storage.isRemoteUrl(updatedRecord.image_path) ? updatedRecord.image_path : `/api/uploads/purchases/${path.basename(updatedRecord.image_path)}`)
              : null;
            res.json({ success: true, message: 'Item image updated successfully', purchase: updatedRecord });
          });
        }
      );
    } catch (e) {
      console.error('[purchasesRoutes] POST /:id/image error:', e);
      return res.status(500).json({ success: false, message: 'Upload failed: ' + e.message });
    }
  });
});

// Create new purchase record
router.post('/', handleImageUpload, async (req, res) => {
  // debug: print received body and file info
  console.log('[purchasesRoutes] POST / - req.body keys:', Object.keys(req.body));
  console.log('[purchasesRoutes] POST / - content-type:', req.headers['content-type']);
  console.log('[purchasesRoutes] POST / - req.files:', req.files);
  console.log('[purchasesRoutes] POST / - req.file present:', !!req.file);
  if (req.file) console.log('[purchasesRoutes] POST / - file meta:', { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size });

  const { date, name, pcs, unit_price, description, supplier_name } = req.body;

  // Validation
  if (!date || !name || !pcs || !unit_price) {
    return res.status(400).json({ success: false, message: 'Date, Name, Pcs, and Unit Price are required' });
  }

  // Calculate total amount
  const total_amount = parseFloat(pcs) * parseFloat(unit_price);

  // 1. Save image to FTP (or local); storage returns the URL/path to store in DB
  let imagePath = null;
  try {
    const fileList = Array.isArray(req.files) ? req.files : (req.files && typeof req.files === 'object' ? Object.values(req.files).flat() : []);
    const uploaded = fileList[0] || req.file || null;
    if (uploaded) {
      const buffer = uploaded.buffer || (uploaded.path ? fs.readFileSync(uploaded.path) : null);
      if (buffer) {
        const filename = uploaded.filename || 'purchase-' + Date.now() + path.extname(uploaded.originalname || '.png');
        const relativePath = 'purchases/' + filename;
        const saved = await storage.saveFile(buffer, relativePath);
        imagePath = saved.path; // FTP: full URL; local: file path
        console.log('[purchasesRoutes] Image saved, database url:', imagePath);
      }
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to save image: ' + e.message });
  }

  // 2. Store the URL in the database (image_path)
  db.run(
    `INSERT INTO purchases (date, name, pcs, unit_price, total_amount, description, supplier_name, available_stock, image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [date, name, pcs, unit_price, total_amount, description || '', supplier_name || '', pcs, imagePath],
    function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Error creating purchase record' });
      }

      // 3. Return record with image_url = database URL (frontend uses this to display)
      db.get('SELECT * FROM purchases WHERE id = ?', [this.lastID], (err, record) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        record.image_url = record && record.image_path ? (storage.isRemoteUrl(record.image_path) ? record.image_path : `/api/uploads/purchases/${path.basename(record.image_path)}`) : null;
        res.json({ success: true, message: 'Purchase record created successfully', purchase: record });
      });
    }
  );
});

// Update purchase record
router.put('/:id', handleImageUpload, async (req, res) => {
  const { id } = req.params;
  const { date, name, pcs, unit_price, description, supplier_name } = req.body;

  // Check if record exists
  db.get('SELECT * FROM purchases WHERE id = ?', [id], async (err, record) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (!record) return res.status(404).json({ success: false, message: 'Purchase record not found' });

    // Calculate total amount if pcs or unit_price is provided
    let total_amount = record.total_amount;
    const finalPcs = pcs !== undefined ? pcs : record.pcs;
    const finalUnitPrice = unit_price !== undefined ? unit_price : record.unit_price;
    total_amount = parseFloat(finalPcs) * parseFloat(finalUnitPrice);

    // Calculate new available_stock if pcs changed
    let newAvailableStock = record.available_stock;
    if (pcs !== undefined && pcs !== record.pcs) {
      const pcsDiff = parseInt(pcs) - parseInt(record.pcs);
      newAvailableStock = Math.max(0, (parseInt(record.available_stock) || 0) + pcsDiff);
    }

    // 1. If new image selected: save to FTP (or local), get URL to store in DB
    let imagePath = null;
    try {
      const fileList = Array.isArray(req.files) ? req.files : (req.files && typeof req.files === 'object' ? Object.values(req.files).flat() : []);
      const uploaded = fileList[0] || req.file || null;
      if (uploaded) {
        const buffer = uploaded.buffer || (uploaded.path ? fs.readFileSync(uploaded.path) : null);
        if (buffer) {
          const filename = uploaded.filename || 'purchase-' + Date.now() + path.extname(uploaded.originalname || '.png');
          const relativePath = 'purchases/' + filename;
          const saved = await storage.saveFile(buffer, relativePath);
          imagePath = saved.path;
          if (record.image_path) {
            try { storage.deleteFile(record.image_path); } catch (e) { /* ignore */ }
          }
          console.log('[purchasesRoutes] Image saved, database url:', imagePath);
        }
      }
    } catch (e) {
      return res.status(500).json({ success: false, message: 'Failed to save image: ' + e.message });
    }

    // Update record
    db.run(
      `UPDATE purchases SET 
        date = COALESCE(?, date),
        name = COALESCE(?, name),
        pcs = COALESCE(?, pcs),
        unit_price = COALESCE(?, unit_price),
        total_amount = ?,
        description = COALESCE(?, description),
        supplier_name = COALESCE(?, supplier_name),
        image_path = COALESCE(?, image_path),
        available_stock = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        date || null,
        name || null,
        pcs !== undefined ? pcs : null,
        unit_price !== undefined ? unit_price : null,
        total_amount,
        description !== undefined ? description : null,
        supplier_name !== undefined ? supplier_name : null,
        imagePath || null,
        newAvailableStock,
        id
      ],
      function(err) {
        if (err) return res.status(500).json({ success: false, message: 'Error updating purchase record' });

        // 3. Return record with image_url = database URL (frontend uses this to display)
        db.get('SELECT * FROM purchases WHERE id = ?', [id], (err, updatedRecord) => {
          if (err) return res.status(500).json({ success: false, message: 'Database error' });
          updatedRecord.image_url = updatedRecord && updatedRecord.image_path ? (storage.isRemoteUrl(updatedRecord.image_path) ? updatedRecord.image_path : `/api/uploads/purchases/${path.basename(updatedRecord.image_path)}`) : null;
          res.json({ success: true, message: 'Purchase record updated successfully', purchase: updatedRecord });
        });
      }
    );
  });
});

// Delete purchase record
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  // Check if record exists
  db.get('SELECT id FROM purchases WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Purchase record not found'
      });
    }

    // Delete record
    db.run('DELETE FROM purchases WHERE id = ?', [id], function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error deleting purchase record'
        });
      }

      res.json({
        success: true,
        message: 'Purchase record deleted successfully'
      });
    });
  });
});

module.exports = router;
