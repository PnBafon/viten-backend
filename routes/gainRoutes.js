const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/gain?date=YYYY-MM-DD
// GET /api/gain?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns per-sale gain/loss rows and aggregated totals
router.get('/', (req, res) => {
  const { date, startDate, endDate } = req.query;
  let start = startDate;
  let end = endDate;
  if (date) {
    start = date;
    end = date;
  }

  if (!start || !end) {
    return res.status(400).json({ success: false, message: 'Provide `date` or both `startDate` and `endDate` in YYYY-MM-DD format' });
  }

  // Fetch purchases first (to determine unit cost), then income + debts in the requested date range
  db.all('SELECT * FROM purchases ORDER BY date DESC, created_at DESC', [], (pErr, purchases) => {
    if (pErr) {
      console.error('[gainRoutes] purchases query error', pErr);
      return res.status(500).json({ success: false, message: 'Database error fetching purchases' });
    }

    // normalize date comparison by taking the first 10 chars (handles "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS" formats)
    const dateWhere = "substring(date,1,10) >= ? AND substring(date,1,10) <= ?";

    db.all(
      `SELECT * FROM income WHERE ${dateWhere} ORDER BY date ASC, created_at ASC`,
      [start, end],
      (iErr, incomes) => {
        if (iErr) {
          console.error('[gainRoutes] income query error', iErr);
          return res.status(500).json({ success: false, message: 'Database error fetching income' });
        }

        db.all(
          `SELECT * FROM debts WHERE ${dateWhere} ORDER BY date ASC, created_at ASC`,
          [start, end],
          (dErr, debts) => {
            if (dErr) {
              console.error('[gainRoutes] debts query error', dErr);
              return res.status(500).json({ success: false, message: 'Database error fetching debts' });
            }

            // Combine income + debts as sales-type records
            const combined = [];

            (incomes || []).forEach((s) => {
              const inventoryItem = (purchases || []).find(p => p.name === s.name);
              const cost_unit_price = inventoryItem ? parseFloat(inventoryItem.unit_price) || 0 : 0;
              const selling_unit_price = parseFloat(s.unit_price) || 0;
              const pcs = parseInt(s.pcs) || 0;
              const total_cost = cost_unit_price * pcs;
              const total_sale = parseFloat(s.total_price) || (selling_unit_price * pcs);
              const gain_loss = total_sale - total_cost;
              combined.push({
                id: s.id,
                source: 'income',
                date: (s.date || '').toString(),
                name: s.name,
                pcs,
                cost_unit_price,
                selling_unit_price,
                total_cost,
                total_sale,
                gain_loss
              });
            });

            (debts || []).forEach((d) => {
              const inventoryItem = (purchases || []).find(p => p.name === d.name);
              const cost_unit_price = inventoryItem ? parseFloat(inventoryItem.unit_price) || 0 : 0;
              const selling_unit_price = parseFloat(d.unit_price) || 0;
              const pcs = parseInt(d.pcs) || 0;
              const total_cost = cost_unit_price * pcs;
              const total_sale = parseFloat(d.total_price) || (selling_unit_price * pcs);
              const gain_loss = total_sale - total_cost;
              combined.push({
                id: `debt-${d.id}`,
                source: 'debt',
                date: (d.date || '').toString(),
                name: d.name,
                pcs,
                cost_unit_price,
                selling_unit_price,
                total_cost,
                total_sale,
                gain_loss
              });
            });

            // Sort combined by date then created_at if present
            combined.sort((a, b) => {
              if ((a.date || '') < (b.date || '')) return -1;
              if ((a.date || '') > (b.date || '')) return 1;
              return 0;
            });

            const totals = combined.reduce(
              (acc, r) => {
                acc.total_cost += r.total_cost || 0;
                acc.total_sale += r.total_sale || 0;
                acc.total_gain_loss += r.gain_loss || 0;
                return acc;
              },
              { total_cost: 0, total_sale: 0, total_gain_loss: 0 }
            );

            res.json({ success: true, gain: combined, totals, startDate: start, endDate: end });
          }
        );
      }
    );
  });
});

module.exports = router;
