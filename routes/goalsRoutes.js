const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all goals (optional filter: ?status=active|accomplished|trashed)
router.get('/', (req, res) => {
  const { status } = req.query;
  const orderBy = 'ORDER BY created_at DESC, id DESC';

  if (status) {
    db.all(
      'SELECT * FROM goals WHERE status = ? ' + orderBy,
      [status],
      (err, records) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.json({ success: true, goals: records || [] });
      }
    );
  } else {
    db.all(
      'SELECT * FROM goals ' + orderBy,
      [],
      (err, records) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.json({ success: true, goals: records || [] });
      }
    );
  }
});

// Get single goal
router.get('/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM goals WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    if (!record) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }
    res.json({ success: true, goal: record });
  });
});

// Create goal
router.post('/', (req, res) => {
  const { date, title, desired_completion_date, content } = req.body;
  if (!date || !title) {
    return res.status(400).json({
      success: false,
      message: 'Date and title are required'
    });
  }

  db.run(
    `INSERT INTO goals (date, title, desired_completion_date, content, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [date, title, desired_completion_date || null, content || ''],
    function (err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Error creating goal' });
      }
      db.get('SELECT * FROM goals WHERE id = ?', [this.lastID], (err, record) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.json({ success: true, message: 'Goal created successfully', goal: record });
      });
    }
  );
});

// Update goal (edit or set status: accomplished / trashed)
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { date, title, desired_completion_date, content, status } = req.body;

  db.get('SELECT * FROM goals WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    if (!record) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }

    const newDate = date !== undefined ? date : record.date;
    const newTitle = title !== undefined ? title : record.title;
    const newDesired = desired_completion_date !== undefined ? desired_completion_date : record.desired_completion_date;
    const newContent = content !== undefined ? content : record.content;
    const newStatus = status !== undefined ? status : record.status;

    db.run(
      `UPDATE goals SET
        date = ?,
        title = ?,
        desired_completion_date = ?,
        content = ?,
        status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [newDate, newTitle, newDesired, newContent, newStatus, id],
      function (err) {
        if (err) {
          return res.status(500).json({ success: false, message: 'Error updating goal' });
        }
        db.get('SELECT * FROM goals WHERE id = ?', [id], (err, updatedRecord) => {
          if (err) {
            return res.status(500).json({ success: false, message: 'Database error' });
          }
          res.json({ success: true, message: 'Goal updated successfully', goal: updatedRecord });
        });
      }
    );
  });
});

// Delete goal permanently
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT id FROM goals WHERE id = ?', [id], (err, record) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    if (!record) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }
    db.run('DELETE FROM goals WHERE id = ?', [id], function (err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Error deleting goal' });
      }
      res.json({ success: true, message: 'Goal deleted successfully' });
    });
  });
});

module.exports = router;
