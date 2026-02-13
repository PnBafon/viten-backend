const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all purchases records
router.get('/', (req, res) => {
  db.all(
    'SELECT * FROM purchases ORDER BY date DESC, created_at DESC',
    [],
    (err, records) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      res.json({
        success: true,
        purchases: records || []
      });
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

      res.json({
        success: true,
        purchase: record
      });
    }
  );
});

// Create new purchase record
router.post('/', (req, res) => {
  const { date, name, pcs, unit_price, description, supplier_name } = req.body;

  // Validation
  if (!date || !name || !pcs || !unit_price) {
    return res.status(400).json({
      success: false,
      message: 'Date, Name, Pcs, and Unit Price are required'
    });
  }

  // Calculate total amount
  const total_amount = parseFloat(pcs) * parseFloat(unit_price);

  // Insert new purchase record (initialize available_stock with pcs)
  db.run(
    `INSERT INTO purchases (date, name, pcs, unit_price, total_amount, description, supplier_name, available_stock)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [date, name, pcs, unit_price, total_amount, description || '', supplier_name || '', pcs],
    function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error creating purchase record'
        });
      }

      // Get created record
      db.get(
        'SELECT * FROM purchases WHERE id = ?',
        [this.lastID],
        (err, record) => {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Database error'
            });
          }

          res.json({
            success: true,
            message: 'Purchase record created successfully',
            purchase: record
          });
        }
      );
    }
  );
});

// Update purchase record
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { date, name, pcs, unit_price, description, supplier_name } = req.body;

  // Check if record exists
  db.get('SELECT * FROM purchases WHERE id = ?', [id], (err, record) => {
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
        newAvailableStock,
        id
      ],
      function(err) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Error updating purchase record'
          });
        }

        // Get updated record
        db.get(
          'SELECT * FROM purchases WHERE id = ?',
          [id],
          (err, updatedRecord) => {
            if (err) {
              return res.status(500).json({
                success: false,
                message: 'Database error'
              });
            }

            res.json({
              success: true,
              message: 'Purchase record updated successfully',
              purchase: updatedRecord
            });
          }
        );
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
