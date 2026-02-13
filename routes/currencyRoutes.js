const express = require('express');
const router = express.Router();
const db = require('../db');

// Ensure default currency exists (tables created in server.js)
function initializeCurrencyTable() {
  db.get('SELECT id FROM currencies WHERE code = ?', ['FCFA'], (err, row) => {
    if (err) console.error('Error checking FCFA:', err.message);
    else if (!row) {
      db.run(
        'INSERT INTO currencies (code, name, symbol, conversion_rate_to_fcfa, is_default) VALUES (?, ?, ?, ?, ?)',
        ['FCFA', 'Central African CFA Franc', 'FCFA', 1.0, 1],
        (e) => { if (e) console.error('Error inserting FCFA:', e.message); else console.log('FCFA currency created as default'); }
      );
    }
  });
}

// Initialize on module load
initializeCurrencyTable();

// Get all currencies (FCFA first, then others)
router.get('/', (req, res) => {
  db.all(
    `SELECT id, code, name, symbol, conversion_rate_to_fcfa, is_default, created_at, updated_at
     FROM currencies
     ORDER BY 
       CASE WHEN code = 'FCFA' THEN 0 ELSE 1 END,
       is_default DESC,
       name ASC`,
    [],
    (err, currencies) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      res.json({
        success: true,
        currencies: currencies || []
      });
    }
  );
});

// Get default currency
router.get('/default', (req, res) => {
  db.get(
    'SELECT * FROM currencies WHERE is_default = 1 LIMIT 1',
    [],
    (err, currency) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      if (!currency) {
        // Fallback to FCFA if no default is set
        db.get('SELECT * FROM currencies WHERE code = ?', ['FCFA'], (err, fcfa) => {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Database error'
            });
          }
          res.json({
            success: true,
            currency: fcfa || { code: 'FCFA', name: 'Central African CFA Franc', symbol: 'FCFA', conversion_rate_to_fcfa: 1.0 }
          });
        });
      } else {
        res.json({
          success: true,
          currency: currency
        });
      }
    }
  );
});

// Create new currency
router.post('/', (req, res) => {
  const { code, name, symbol, conversion_rate_to_fcfa } = req.body;

  // Validation
  if (!code || !name || conversion_rate_to_fcfa === undefined || conversion_rate_to_fcfa <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Code, name, and valid conversion rate are required'
    });
  }

  // Check if code already exists
  db.get('SELECT id FROM currencies WHERE code = ?', [code.toUpperCase()], (err, row) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (row) {
      return res.status(400).json({
        success: false,
        message: 'Currency code already exists'
      });
    }

    // Insert new currency
    db.run(
      `INSERT INTO currencies (code, name, symbol, conversion_rate_to_fcfa)
       VALUES (?, ?, ?, ?)`,
      [code.toUpperCase(), name, symbol || code.toUpperCase(), parseFloat(conversion_rate_to_fcfa)],
      function(err) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Error creating currency'
          });
        }

        res.json({
          success: true,
          message: 'Currency created successfully',
          currency: {
            id: this.lastID,
            code: code.toUpperCase(),
            name,
            symbol: symbol || code.toUpperCase(),
            conversion_rate_to_fcfa: parseFloat(conversion_rate_to_fcfa),
            is_default: 0
          }
        });
      }
    );
  });
});

// Update currency
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { code, name, symbol, conversion_rate_to_fcfa } = req.body;

  // Check if currency exists
  db.get('SELECT * FROM currencies WHERE id = ?', [id], (err, currency) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!currency) {
      return res.status(404).json({
        success: false,
        message: 'Currency not found'
      });
    }

    // If code is being changed, check if new code already exists
    if (code && code.toUpperCase() !== currency.code) {
      db.get('SELECT id FROM currencies WHERE code = ? AND id != ?', [code.toUpperCase(), id], (err, row) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Database error'
          });
        }

        if (row) {
          return res.status(400).json({
            success: false,
            message: 'Currency code already exists'
          });
        }

        updateCurrency();
      });
    } else {
      updateCurrency();
    }

    function updateCurrency() {
      const updateCode = code ? code.toUpperCase() : currency.code;
      const updateName = name || currency.name;
      const updateSymbol = symbol !== undefined ? symbol : currency.symbol;
      const updateRate = conversion_rate_to_fcfa !== undefined ? parseFloat(conversion_rate_to_fcfa) : currency.conversion_rate_to_fcfa;

      if (updateRate <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Conversion rate must be greater than 0'
        });
      }

      db.run(
        `UPDATE currencies 
         SET code = ?, name = ?, symbol = ?, conversion_rate_to_fcfa = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [updateCode, updateName, updateSymbol, updateRate, id],
        function(err) {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Error updating currency'
            });
          }

          res.json({
            success: true,
            message: 'Currency updated successfully'
          });
        }
      );
    }
  });
});

// Set default currency
router.put('/:id/set-default', (req, res) => {
  const { id } = req.params;

  // Check if currency exists
  db.get('SELECT * FROM currencies WHERE id = ?', [id], (err, currency) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!currency) {
      return res.status(404).json({
        success: false,
        message: 'Currency not found'
      });
    }

    // Set all currencies to not default
    db.run('UPDATE currencies SET is_default = 0', (err) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      // Set selected currency as default
      db.run(
        'UPDATE currencies SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id],
        function(err) {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Error setting default currency'
            });
          }

          res.json({
            success: true,
            message: 'Default currency updated successfully'
          });
        }
      );
    });
  });
});

// Delete currency
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  // Check if currency exists
  db.get('SELECT * FROM currencies WHERE id = ?', [id], (err, currency) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!currency) {
      return res.status(404).json({
        success: false,
        message: 'Currency not found'
      });
    }

    // Prevent deletion of FCFA
    if (currency.code === 'FCFA') {
      return res.status(400).json({
        success: false,
        message: 'FCFA currency cannot be deleted'
      });
    }

    // If deleting default currency, set FCFA as default
    if (currency.is_default) {
      db.run('UPDATE currencies SET is_default = 1 WHERE code = ?', ['FCFA'], (err) => {
        if (err) {
          console.error('Error setting FCFA as default:', err.message);
        }
      });
    }

    // Delete currency
    db.run('DELETE FROM currencies WHERE id = ?', [id], function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error deleting currency'
        });
      }

      res.json({
        success: true,
        message: 'Currency deleted successfully'
      });
    });
  });
});

module.exports = router;
