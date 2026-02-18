const express = require('express');
const path = require('path');
const fs = require('fs');
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
    const ext = path.extname(file.originalname || '').toLowerCase();
    // log file info to help debug uploads (originalname, mimetype)
    console.log('[purchasesRoutes] incoming file:', { originalname: file.originalname, mimetype: file.mimetype, ext });

    // Accept if either the extension or MIME type matches common image types (more forgiving)
    const okByExt = Boolean(ext && allowedTypes.test(ext));
    const okByMime = Boolean(file.mimetype && allowedTypes.test(file.mimetype));
    const ok = okByExt || okByMime;

    cb(ok ? null : new Error('Only image files are allowed!'));
  }
});

const handleImageUpload = (req, res, next) => {
  // use upload.any() for debugging + broader compatibility (accept any file field)
  const uploader = upload.any();
  uploader(req, res, (err) => {
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
      const mapped = (records || []).map(r => {
        const rec = { ...r };
        if (rec.image_path) {
          if (storage.isRemoteUrl(rec.image_path)) {
            rec.image_url = rec.image_path;
          } else {
            const localPath = storage.getLocalPath(rec.image_path) || rec.image_path;
            const rel = path.relative(storage.uploadsDir, localPath).replace(/\\\\/g, '/');
            rec.image_url = `/api/uploads/${rel}`;
          }
        } else {
          rec.image_url = null;
        }
        // debug: show what image_url is returned for this record (helps trace missing images)
        if (process.env.DEBUG_UPLOADS === 'true') {
          console.log('[purchasesRoutes] returning purchase record image_url:', { id: rec.id, image_path: rec.image_path, image_url: rec.image_url });
        }
        return rec;
      });
      res.json({ success: true, purchases: mapped });
    }
  );
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
        record.image_url = storage.isRemoteUrl(record.image_path) ? record.image_path : `/api/uploads/${path.basename(record.image_path)}`;
      } else {
        record.image_url = null;
      }

      res.json({ success: true, purchase: record });
    }
  );
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

  // Handle optional uploaded image (support req.file OR req.files[0])
  let imagePath = null;
  try {
    const uploaded = req.file || (Array.isArray(req.files) && req.files[0]) || null;
    if (uploaded) {
      const buffer = uploaded.buffer || (uploaded.path ? fs.readFileSync(uploaded.path) : null);
      if (buffer) {
        const filename = uploaded.filename || 'purchase-' + Date.now() + path.extname(uploaded.originalname || '.png');
        const relativePath = 'backups/' + filename; // save under backups for debugging
        const saved = await storage.saveFile(buffer, relativePath);
        console.log('[purchasesRoutes] Saved image for purchase:', { originalname: uploaded.originalname, stored: saved });
        imagePath = saved.path;
      }
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to save image: ' + e.message });
  }

  // Insert new purchase record (initialize available_stock with pcs)
  db.run(
    `INSERT INTO purchases (date, name, pcs, unit_price, total_amount, description, supplier_name, available_stock, image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [date, name, pcs, unit_price, total_amount, description || '', supplier_name || '', pcs, imagePath],
    function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Error creating purchase record' });
      }

      // Get created record
      db.get('SELECT * FROM purchases WHERE id = ?', [this.lastID], (err, record) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        if (record && record.image_path) {
          if (storage.isRemoteUrl(record.image_path)) {
            record.image_url = record.image_path;
          } else {
            const localPath = storage.getLocalPath(record.image_path) || record.image_path;
            const rel = path.relative(storage.uploadsDir, localPath).replace(/\\/g, '/');
            record.image_url = `/api/uploads/${rel}`;
          }
        } else {
          record.image_url = null;
        }
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

    // Handle optional new image (support req.file or req.files[0])
    let imagePath = null;
    try {
      const uploaded = req.file || (Array.isArray(req.files) && req.files[0]) || null;
      if (uploaded) {
        const buffer = uploaded.buffer || (uploaded.path ? fs.readFileSync(uploaded.path) : null);
        if (buffer) {
          const filename = uploaded.filename || 'purchase-' + Date.now() + path.extname(uploaded.originalname || '.png');
          const relativePath = 'backups/' + filename; // save under backups for debugging
          const saved = await storage.saveFile(buffer, relativePath);
          imagePath = saved.path;
          if (record.image_path) {
            try { storage.deleteFile(record.image_path); } catch (e) { /* ignore */ }
          }
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

        // Get updated record
        db.get('SELECT * FROM purchases WHERE id = ?', [id], (err, updatedRecord) => {
          if (err) return res.status(500).json({ success: false, message: 'Database error' });
          if (updatedRecord && updatedRecord.image_path) {
            if (storage.isRemoteUrl(updatedRecord.image_path)) {
              updatedRecord.image_url = updatedRecord.image_path;
            } else {
              const localPath = storage.getLocalPath(updatedRecord.image_path) || updatedRecord.image_path;
              const rel = path.relative(storage.uploadsDir, localPath).replace(/\\/g, '/');
              updatedRecord.image_url = `/api/uploads/${rel}`;
            }
          } else {
            updatedRecord.image_url = null;
          }
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
