const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all income records
router.get('/', (req, res) => {
  db.all(
    'SELECT * FROM income ORDER BY date DESC, created_at DESC',
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
        income: records || []
      });
    }
  );
});

// Get single income record
router.get('/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    'SELECT * FROM income WHERE id = ?',
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
          message: 'Income record not found'
        });
      }

      res.json({
        success: true,
        income: record
      });
    }
  );
});

// Create new income record
router.post('/', (req, res) => {
  const { date, name, pcs, unit_price, description, customer_signature, electronic_signature, client_name, client_phone, seller_name } = req.body;

  // Validation
  if (!date || !name || !pcs || !unit_price) {
    return res.status(400).json({
      success: false,
      message: 'Date, Name, Pcs, and Unit Price are required'
    });
  }

  // Calculate total price
  const total_price = parseFloat(pcs) * parseFloat(unit_price);

  // First, check if inventory item exists and has enough stock
  db.get(
    'SELECT id, available_stock FROM purchases WHERE name = ? ORDER BY id DESC LIMIT 1',
    [name],
    (err, inventoryItem) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      if (!inventoryItem) {
        return res.status(400).json({
          success: false,
          message: 'Item not found in inventory'
        });
      }

      const salePcs = parseInt(pcs) || 0;
      const currentStock = parseInt(inventoryItem.available_stock) || 0;

      if (salePcs > currentStock) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock. Available: ${currentStock}, Requested: ${salePcs}`
        });
      }

      // Insert new income record
      db.run(
        `INSERT INTO income (date, name, pcs, unit_price, total_price, description, customer_signature, electronic_signature, client_name, client_phone, seller_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [date, name, pcs, unit_price, total_price, description || '', customer_signature || '', electronic_signature || '', client_name || '', client_phone || '', seller_name || ''],
        function(err) {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Error creating income record'
            });
          }

          // Deduct stock from inventory
          const newStock = currentStock - salePcs;
          db.run(
            'UPDATE purchases SET available_stock = ? WHERE id = ?',
            [newStock, inventoryItem.id],
            (updateErr) => {
              if (updateErr) {
                console.error('Error updating stock:', updateErr);
                // Don't fail the request, just log the error
              }

              // Get created record
              db.get(
                'SELECT * FROM income WHERE id = ?',
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
                    message: 'Income record created successfully',
                    income: record
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// Update income record
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { date, name, pcs, unit_price, description, customer_signature, electronic_signature, client_name, client_phone, seller_name } = req.body;

  // Check if record exists
  db.get('SELECT * FROM income WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Income record not found'
      });
    }

    // Calculate total price if pcs or unit_price is provided
    let total_price = record.total_price;
    const finalPcs = pcs !== undefined ? pcs : record.pcs;
    const finalUnitPrice = unit_price !== undefined ? unit_price : record.unit_price;
    total_price = parseFloat(finalPcs) * parseFloat(finalUnitPrice);

    // Update record
    db.run(
      `UPDATE income SET 
        date = COALESCE(?, date),
        name = COALESCE(?, name),
        pcs = COALESCE(?, pcs),
        unit_price = COALESCE(?, unit_price),
        total_price = ?,
        description = COALESCE(?, description),
        customer_signature = COALESCE(?, customer_signature),
        electronic_signature = COALESCE(?, electronic_signature),
        client_name = COALESCE(?, client_name),
        client_phone = COALESCE(?, client_phone),
        seller_name = COALESCE(?, seller_name),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        date || null,
        name || null,
        pcs !== undefined ? pcs : null,
        unit_price !== undefined ? unit_price : null,
        total_price,
        description !== undefined ? description : null,
        customer_signature !== undefined ? customer_signature : null,
        electronic_signature !== undefined ? electronic_signature : null,
        client_name !== undefined ? client_name : null,
        client_phone !== undefined ? client_phone : null,
        seller_name !== undefined ? seller_name : null,
        id
      ],
      function(err) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Error updating income record'
          });
        }

        // Get updated record
        db.get(
          'SELECT * FROM income WHERE id = ?',
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
              message: 'Income record updated successfully',
              income: updatedRecord
            });
          }
        );
      }
    );
  });
});

// Delete income record
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  // Check if record exists
  db.get('SELECT id FROM income WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Income record not found'
      });
    }

    // Delete record
    db.run('DELETE FROM income WHERE id = ?', [id], function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error deleting income record'
        });
      }

      res.json({
        success: true,
        message: 'Income record deleted successfully'
      });
    });
  });
});

module.exports = router;
