const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all expenses records
router.get('/', (req, res) => {
  db.all(
    'SELECT * FROM expenses ORDER BY date DESC, created_at DESC',
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
        expenses: records || []
      });
    }
  );
});

// Get single expense record
router.get('/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    'SELECT * FROM expenses WHERE id = ?',
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
          message: 'Expense record not found'
        });
      }

      res.json({
        success: true,
        expense: record
      });
    }
  );
});

// Create new expense record
router.post('/', (req, res) => {
  const { date, name, amount, description } = req.body;

  // Validation
  if (!date || !name || !amount) {
    return res.status(400).json({
      success: false,
      message: 'Date, Name, and Amount are required'
    });
  }

  // Insert new expense record
  db.run(
    `INSERT INTO expenses (date, name, amount, description)
     VALUES (?, ?, ?, ?)`,
    [date, name, amount, description || ''],
    function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error creating expense record'
        });
      }

      // Get created record
      db.get(
        'SELECT * FROM expenses WHERE id = ?',
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
            message: 'Expense record created successfully',
            expense: record
          });
        }
      );
    }
  );
});

// Update expense record
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { date, name, amount, description } = req.body;

  // Check if record exists
  db.get('SELECT * FROM expenses WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Expense record not found'
      });
    }

    // Update record
    db.run(
      `UPDATE expenses SET 
        date = COALESCE(?, date),
        name = COALESCE(?, name),
        amount = COALESCE(?, amount),
        description = COALESCE(?, description),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        date || null,
        name || null,
        amount !== undefined ? amount : null,
        description !== undefined ? description : null,
        id
      ],
      function(err) {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Error updating expense record'
          });
        }

        // Get updated record
        db.get(
          'SELECT * FROM expenses WHERE id = ?',
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
              message: 'Expense record updated successfully',
              expense: updatedRecord
            });
          }
        );
      }
    );
  });
});

// Delete expense record
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  // Check if record exists
  db.get('SELECT id FROM expenses WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Expense record not found'
      });
    }

    // Delete record
    db.run('DELETE FROM expenses WHERE id = ?', [id], function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error deleting expense record'
        });
      }

      res.json({
        success: true,
        message: 'Expense record deleted successfully'
      });
    });
  });
});

module.exports = router;
