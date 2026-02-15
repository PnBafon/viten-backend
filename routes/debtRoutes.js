const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all debt records
router.get('/', (req, res) => {
  db.all(
    'SELECT * FROM debts ORDER BY date DESC, created_at DESC',
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
        debts: records || []
      });
    }
  );
});

// Get debt by receipt number (e.g. DEBT-000001) for repay flow
router.get('/by-receipt/:receiptNo', (req, res) => {
  const receiptNo = (req.params.receiptNo || '').trim().toUpperCase();
  const match = receiptNo.match(/^DEBT-(\d+)$/);
  if (!match) {
    return res.status(400).json({ success: false, message: 'Invalid receipt number. Use format DEBT-000001' });
  }
  const debtId = parseInt(match[1], 10);
  db.get('SELECT * FROM debts WHERE id = ?', [debtId], (err, debt) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (!debt) return res.status(404).json({ success: false, message: 'Debt not found for this receipt number' });
    db.all(
      'SELECT id, payment_date, amount, receipt_number, created_at FROM debt_repayments WHERE debt_id = ? ORDER BY payment_date ASC, created_at ASC',
      [debtId],
      (err2, payments) => {
        if (err2) return res.status(500).json({ success: false, message: 'Database error' });
        res.json({
          success: true,
          debt,
          payments: payments || [],
          balance_owed: debt.balance_owed
        });
      }
    );
  });
});

// Get single debt record
router.get('/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    'SELECT * FROM debts WHERE id = ?',
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
          message: 'Debt record not found'
        });
      }

      res.json({
        success: true,
        debt: record
      });
    }
  );
});

// Create new debt record
router.post('/', (req, res) => {
  const { date, name, pcs, unit_price, total_price, amount_payable_now, description, customer_signature, electronic_signature, client_name, client_phone, seller_name } = req.body;

  // Validation
  if (!date || !name || !pcs || !unit_price || total_price === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Date, Name, Pcs, Unit Price, and Total Price are required'
    });
  }

  // Calculate balance owed
  const totalPrice = parseFloat(total_price) || 0;
  const amountPayable = parseFloat(amount_payable_now) || 0;
  const balanceOwed = totalPrice - amountPayable;

  // Check if inventory item exists and has enough stock
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

      const debtPcs = parseInt(pcs) || 0;
      const currentStock = parseInt(inventoryItem.available_stock) || 0;

      if (debtPcs > currentStock) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock. Available: ${currentStock}, Requested: ${debtPcs}`
        });
      }

      // Insert debt record
      db.run(
        `INSERT INTO debts (date, name, pcs, unit_price, total_price, amount_payable_now, balance_owed, description, customer_signature, electronic_signature, client_name, client_phone, seller_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          date,
          name,
          debtPcs,
          parseFloat(unit_price),
          totalPrice,
          amountPayable,
          balanceOwed,
          description || '',
          customer_signature || '',
          electronic_signature || '',
          client_name || '',
          client_phone || '',
          seller_name || ''
        ],
        function(err) {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Error creating debt record'
            });
          }

          // Deduct stock from inventory
          const newStock = currentStock - debtPcs;
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
                'SELECT * FROM debts WHERE id = ?',
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
                    message: 'Debt record created successfully',
                    debt: record
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

// Update debt record
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { date, name, pcs, unit_price, total_price, amount_payable_now, description, customer_signature, electronic_signature, client_name, client_phone, seller_name } = req.body;

  // Check if record exists
  db.get('SELECT * FROM debts WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Debt record not found'
      });
    }

    // Calculate balance owed
    const totalPrice = total_price !== undefined ? parseFloat(total_price) : record.total_price;
    const amountPayable = amount_payable_now !== undefined ? parseFloat(amount_payable_now) : record.amount_payable_now;
    const balanceOwed = totalPrice - amountPayable;

    // Update record
    db.run(
      `UPDATE debts SET
        date = COALESCE(?, date),
        name = COALESCE(?, name),
        pcs = COALESCE(?, pcs),
        unit_price = COALESCE(?, unit_price),
        total_price = COALESCE(?, total_price),
        amount_payable_now = COALESCE(?, amount_payable_now),
        balance_owed = ?,
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
        pcs !== undefined ? parseInt(pcs) : null,
        unit_price !== undefined ? parseFloat(unit_price) : null,
        total_price !== undefined ? totalPrice : null,
        amount_payable_now !== undefined ? amountPayable : null,
        balanceOwed,
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
            message: 'Error updating debt record'
          });
        }

        res.json({
          success: true,
          message: 'Debt record updated successfully'
        });
      }
    );
  });
});

// Delete debt record
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  // Get the debt record first to restore stock
  db.get('SELECT * FROM debts WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Debt record not found'
      });
    }

    // Restore stock to inventory
    db.get(
      'SELECT id, available_stock FROM purchases WHERE name = ? ORDER BY id DESC LIMIT 1',
      [record.name],
      (err, inventoryItem) => {
        if (!err && inventoryItem) {
          const restoredStock = inventoryItem.available_stock + record.pcs;
          db.run(
            'UPDATE purchases SET available_stock = ? WHERE id = ?',
            [restoredStock, inventoryItem.id],
            (err) => {
              if (err) console.error('Error restoring stock:', err);
            }
          );
        }

        // Delete debt record
        db.run('DELETE FROM debts WHERE id = ?', [id], function(err) {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Error deleting debt record'
            });
          }

          res.json({
            success: true,
            message: 'Debt record deleted successfully'
          });
        });
      }
    );
  });
});

module.exports = router;
