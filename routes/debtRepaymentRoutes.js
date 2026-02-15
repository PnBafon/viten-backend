const express = require('express');
const router = express.Router();
const db = require('../db');

// List all repayments (newest first)
router.get('/', (req, res) => {
  db.all(
    `SELECT r.*, d.date AS debt_date, d.name AS item_name, d.total_price, d.client_name, d.client_phone
     FROM debt_repayments r
     JOIN debts d ON d.id = r.debt_id
     ORDER BY r.payment_date DESC, r.created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ success: false, message: 'Database error' });
      res.json({ success: true, repayments: rows || [] });
    }
  );
});

// Get one repayment by id
router.get('/:id', (req, res) => {
  const id = req.params.id;
  db.get(
    `SELECT r.*, d.date AS debt_date, d.name AS item_name, d.total_price, d.client_name, d.client_phone, d.balance_owed AS debt_balance_after
     FROM debt_repayments r
     JOIN debts d ON d.id = r.debt_id
     WHERE r.id = ?`,
    [id],
    (err, row) => {
      if (err) return res.status(500).json({ success: false, message: 'Database error' });
      if (!row) return res.status(404).json({ success: false, message: 'Repayment not found' });
      res.json({ success: true, repayment: row });
    }
  );
});

// Create repayment: update debt (amount_payable_now, balance_owed) and insert repayment
router.post('/', (req, res) => {
  const { debt_id, payment_date, amount, seller_name } = req.body;
  if (!debt_id || !payment_date || amount === undefined || amount === null) {
    return res.status(400).json({ success: false, message: 'debt_id, payment_date, and amount are required' });
  }
  const payAmount = parseFloat(amount);
  if (isNaN(payAmount) || payAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
  }

  db.get('SELECT id, balance_owed, amount_payable_now, total_price FROM debts WHERE id = ?', [debt_id], (err, debt) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (!debt) return res.status(404).json({ success: false, message: 'Debt not found' });
    const balanceOwed = parseFloat(debt.balance_owed) || 0;
    if (payAmount > balanceOwed) {
      return res.status(400).json({ success: false, message: `Amount cannot exceed balance owed (${balanceOwed})` });
    }

    db.run(
      `INSERT INTO debt_repayments (debt_id, payment_date, amount, seller_name) VALUES (?, ?, ?, ?)`,
      [debt_id, payment_date, payAmount, seller_name || ''],
      function(insertErr) {
        if (insertErr) return res.status(500).json({ success: false, message: 'Error creating repayment' });
        const repaymentId = this.lastID;
        const receiptNumber = 'REPAY-' + String(repaymentId).padStart(6, '0');
        db.run(
          'UPDATE debt_repayments SET receipt_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [receiptNumber, repaymentId],
          (updErr) => {
            if (updErr) { /* non-fatal */ }
            const newBalance = balanceOwed - payAmount;
            const newAmountPaid = (parseFloat(debt.amount_payable_now) || 0) + payAmount;
            db.run(
              'UPDATE debts SET amount_payable_now = ?, balance_owed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [newAmountPaid, newBalance, debt_id],
              (debtUpdErr) => {
                if (debtUpdErr) {
                  return res.status(500).json({ success: false, message: 'Error updating debt' });
                }
                db.get(
                  `SELECT r.*, d.date AS debt_date, d.name AS item_name, d.total_price, d.client_name, d.client_phone
                   FROM debt_repayments r JOIN debts d ON d.id = r.debt_id WHERE r.id = ?`,
                  [repaymentId],
                  (getErr, repayment) => {
                    if (getErr) return res.status(500).json({ success: false, message: 'Database error' });
                    const rec = repayment || { id: repaymentId, receipt_number: receiptNumber, debt_id, payment_date, amount: payAmount, seller_name: seller_name || '' };
                    res.json({ success: true, message: 'Repayment recorded', repayment: rec });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// Update repayment: reverse old amount on debt, apply new amount
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const { payment_date, amount, seller_name } = req.body;

  db.get('SELECT * FROM debt_repayments WHERE id = ?', [id], (err, rep) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (!rep) return res.status(404).json({ success: false, message: 'Repayment not found' });

    const newAmount = amount !== undefined && amount !== null ? parseFloat(amount) : rep.amount;
    if (isNaN(newAmount) || newAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    db.get('SELECT id, balance_owed, amount_payable_now FROM debts WHERE id = ?', [rep.debt_id], (err2, debt) => {
      if (err2 || !debt) return res.status(500).json({ success: false, message: 'Debt not found' });
      const oldAmount = parseFloat(rep.amount) || 0;
      const diff = newAmount - oldAmount;
      const newBalance = (parseFloat(debt.balance_owed) || 0) - diff;
      const newAmountPaid = (parseFloat(debt.amount_payable_now) || 0) + diff;
      if (newBalance < 0) {
        return res.status(400).json({ success: false, message: 'Resulting balance cannot be negative' });
      }

      db.run(
        `UPDATE debt_repayments SET payment_date = COALESCE(?, payment_date), amount = ?, seller_name = COALESCE(?, seller_name), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [payment_date || rep.payment_date, newAmount, seller_name !== undefined ? seller_name : rep.seller_name, id],
        (updErr) => {
          if (updErr) return res.status(500).json({ success: false, message: 'Error updating repayment' });
          db.run(
            'UPDATE debts SET amount_payable_now = ?, balance_owed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newAmountPaid, newBalance, rep.debt_id],
            (debtUpdErr) => {
              if (debtUpdErr) return res.status(500).json({ success: false, message: 'Error updating debt' });
              db.get(
                `SELECT r.*, d.date AS debt_date, d.name AS item_name, d.total_price, d.client_name, d.client_phone
                 FROM debt_repayments r JOIN debts d ON d.id = r.debt_id WHERE r.id = ?`,
                [id],
                (getErr, updated) => {
                  if (getErr) return res.status(500).json({ success: false, message: 'Database error' });
                  res.json({ success: true, message: 'Repayment updated', repayment: updated });
                }
              );
            }
          );
        }
      );
    });
  });
});

// Delete repayment: add amount back to balance_owed, subtract from amount_payable_now
router.delete('/:id', (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM debt_repayments WHERE id = ?', [id], (err, rep) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (!rep) return res.status(404).json({ success: false, message: 'Repayment not found' });

    const amount = parseFloat(rep.amount) || 0;
    db.get('SELECT id, balance_owed, amount_payable_now FROM debts WHERE id = ?', [rep.debt_id], (err2, debt) => {
      if (err2 || !debt) return res.status(500).json({ success: false, message: 'Debt not found' });
      const newBalance = (parseFloat(debt.balance_owed) || 0) + amount;
      const newAmountPaid = Math.max(0, (parseFloat(debt.amount_payable_now) || 0) - amount);

      db.run('DELETE FROM debt_repayments WHERE id = ?', [id], (delErr) => {
        if (delErr) return res.status(500).json({ success: false, message: 'Error deleting repayment' });
        db.run(
          'UPDATE debts SET amount_payable_now = ?, balance_owed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [newAmountPaid, newBalance, rep.debt_id],
          (updErr) => {
            if (updErr) return res.status(500).json({ success: false, message: 'Error updating debt' });
            res.json({ success: true, message: 'Repayment deleted' });
          }
        );
      });
    });
  });
});

module.exports = router;
