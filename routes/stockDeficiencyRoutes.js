const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all items with stock deficiency alerts
router.get('/alerts', (req, res) => {
  db.all(
    `SELECT p.id, p.name, p.available_stock, p.stock_deficiency_threshold, p.pcs, p.unit_price
     FROM purchases p
     WHERE p.stock_deficiency_threshold > 0 
     AND p.available_stock <= p.stock_deficiency_threshold
     ORDER BY p.available_stock ASC`,
    [],
    (err, records) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      if (!records || records.length === 0) {
        return res.json({
          success: true,
          alerts: []
        });
      }

      // Calculate pcs sold for each item (from both income/sales and debts)
      const alertsWithSoldPromises = records.map((record) => {
        return new Promise((resolve) => {
          // Get total from income (sales)
          db.get(
            `SELECT COALESCE(SUM(pcs), 0) as total_income 
             FROM income 
             WHERE name = ?`,
            [record.name],
            (err, incomeResult) => {
              if (err) {
                resolve({ ...record, pcs_sold: 0 });
                return;
              }

              const incomeTotal = incomeResult && incomeResult.total_income ? parseInt(incomeResult.total_income) : 0;

              // Get total from debts
              db.get(
                `SELECT COALESCE(SUM(pcs), 0) as total_debts 
                 FROM debts 
                 WHERE name = ?`,
                [record.name],
                (err, debtResult) => {
                  if (err) {
                    resolve({ ...record, pcs_sold: incomeTotal });
                    return;
                  }

                  const debtTotal = debtResult && debtResult.total_debts ? parseInt(debtResult.total_debts) : 0;
                  const totalSold = incomeTotal + debtTotal;

                  resolve({ 
                    ...record, 
                    pcs_sold: totalSold
                  });
                }
              );
            }
          );
        });
      });

      Promise.all(alertsWithSoldPromises).then((alertsWithSold) => {
        res.json({
          success: true,
          alerts: alertsWithSold || []
        });
      }).catch((error) => {
        console.error('Error processing alerts:', error);
        res.json({
          success: true,
          alerts: records.map(record => ({ ...record, pcs_sold: 0 }))
        });
      });
    }
  );
});

// Get all inventory items with their stock info
router.get('/inventory-stock', (req, res) => {
  db.all(
    `SELECT id, name, pcs, available_stock, stock_deficiency_threshold, unit_price
     FROM purchases 
     ORDER BY name ASC`,
    [],
    (err, records) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      if (!records || records.length === 0) {
        return res.json({
          success: true,
          items: []
        });
      }

      // Calculate pcs sold for each item (from both income/sales and debts)
      const itemsWithSoldPromises = records.map((record) => {
        return new Promise((resolve) => {
          // Get total from income (sales)
          db.get(
            `SELECT COALESCE(SUM(pcs), 0) as total_income 
             FROM income 
             WHERE name = ?`,
            [record.name],
            (err, incomeResult) => {
              if (err) {
                resolve({ ...record, pcs_sold: 0 });
                return;
              }

              const incomeTotal = incomeResult && incomeResult.total_income ? parseInt(incomeResult.total_income) : 0;

              // Get total from debts
              db.get(
                `SELECT COALESCE(SUM(pcs), 0) as total_debts 
                 FROM debts 
                 WHERE name = ?`,
                [record.name],
                (err, debtResult) => {
                  if (err) {
                    resolve({ ...record, pcs_sold: incomeTotal });
                    return;
                  }

                  const debtTotal = debtResult && debtResult.total_debts ? parseInt(debtResult.total_debts) : 0;
                  const totalSold = incomeTotal + debtTotal;

                  resolve({ 
                    ...record, 
                    pcs_sold: totalSold
                  });
                }
              );
            }
          );
        });
      });

      Promise.all(itemsWithSoldPromises).then((itemsWithSold) => {
        res.json({
          success: true,
          items: itemsWithSold || []
        });
      }).catch((error) => {
        console.error('Error processing inventory stock:', error);
        res.json({
          success: true,
          items: records.map(record => ({ ...record, pcs_sold: 0 }))
        });
      });
    }
  );
});

// Update stock deficiency threshold for an item
router.put('/threshold/:id', (req, res) => {
  const { id } = req.params;
  const { threshold } = req.body;

  if (threshold === undefined || threshold < 0) {
    return res.status(400).json({
      success: false,
      message: 'Valid threshold value is required'
    });
  }

  // Check if item exists
  db.get('SELECT id FROM purchases WHERE id = ?', [id], (err, item) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    // Update threshold
    db.run(
      'UPDATE purchases SET stock_deficiency_threshold = ? WHERE id = ?',
      [parseInt(threshold), id],
      function(err) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Error updating threshold'
          });
        }

        res.json({
          success: true,
          message: 'Stock deficiency threshold updated successfully'
        });
      }
    );
  });
});

// Update available stock (used when sales are made)
router.put('/stock/:id', (req, res) => {
  const { id } = req.params;
  const { available_stock } = req.body;

  if (available_stock === undefined || available_stock < 0) {
    return res.status(400).json({
      success: false,
      message: 'Valid stock value is required'
    });
  }

  // Check if item exists
  db.get('SELECT id FROM purchases WHERE id = ?', [id], (err, item) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    // Update available stock
    db.run(
      'UPDATE purchases SET available_stock = ? WHERE id = ?',
      [parseInt(available_stock), id],
      function(err) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Error updating stock'
          });
        }

        res.json({
          success: true,
          message: 'Stock updated successfully'
        });
      }
    );
  });
});

module.exports = router;
