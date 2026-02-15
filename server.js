// cSpell:disable
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const { getBaseDir } = require('./dataPath');
const db = require('./db');
const storage = require('./storage');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '127.0.0.1';
const isDev = process.env.NODE_ENV !== 'production';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const baseDir = getBaseDir();
const uploadsDir = storage.uploadsDir;

// CORS: in development allow localhost; in production allow FRONTEND_URL(s) only
const allowedOrigins = FRONTEND_URL
  ? FRONTEND_URL.split(',').map((u) => u.trim()).filter(Boolean)
  : [];
if (isDev) {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173');
}
const corsOptions = allowedOrigins.length
  ? {
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
    }
  : {};
app.use(cors(corsOptions));
app.use(express.json());

// Local uploads only when not using FTP
if (!storage.useFtp) {
  storage.ensureLocalDir();
  app.use('/api/uploads', express.static(uploadsDir));
}

/* ================= DATABASE INIT ================= */

function initPostgresSchema(done) {
  const run = (sql, cb) => db.run(sql, [], cb || (() => {}));
  run(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(100),
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, () => {
    run(`CREATE TABLE IF NOT EXISTS income (
      id SERIAL PRIMARY KEY,
      date VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      pcs INTEGER NOT NULL DEFAULT 1,
      unit_price DOUBLE PRECISION NOT NULL,
      total_price DOUBLE PRECISION NOT NULL,
      description TEXT,
      customer_signature TEXT,
      electronic_signature TEXT,
      client_name VARCHAR(255),
      client_phone VARCHAR(100),
      seller_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, () => {
      run(`CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        date VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`, () => {
        run(`CREATE TABLE IF NOT EXISTS debts (
          id SERIAL PRIMARY KEY,
          date VARCHAR(50) NOT NULL,
          name VARCHAR(255) NOT NULL,
          pcs INTEGER NOT NULL DEFAULT 1,
          unit_price DOUBLE PRECISION NOT NULL,
          total_price DOUBLE PRECISION NOT NULL,
          amount_payable_now DOUBLE PRECISION NOT NULL DEFAULT 0,
          balance_owed DOUBLE PRECISION NOT NULL DEFAULT 0,
          description TEXT,
          customer_signature TEXT,
          electronic_signature TEXT,
          client_name VARCHAR(255),
          client_phone VARCHAR(100),
          seller_name VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`, () => {
          run(`CREATE TABLE IF NOT EXISTS purchases (
            id SERIAL PRIMARY KEY,
            date VARCHAR(50) NOT NULL,
            name VARCHAR(255) NOT NULL,
            pcs INTEGER NOT NULL,
            unit_price DOUBLE PRECISION NOT NULL,
            total_amount DOUBLE PRECISION NOT NULL,
            description TEXT,
            supplier_name VARCHAR(255),
            available_stock INTEGER DEFAULT 0,
            stock_deficiency_threshold INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )`, () => {
            run(`CREATE TABLE IF NOT EXISTS configuration (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              app_name VARCHAR(255) DEFAULT 'Shop Accountant',
              logo_path TEXT DEFAULT NULL,
              location TEXT DEFAULT NULL,
              items TEXT DEFAULT NULL,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`, () => {
              run(`CREATE TABLE IF NOT EXISTS currencies (
                id SERIAL PRIMARY KEY,
                code VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                symbol VARCHAR(20),
                conversion_rate_to_fcfa DOUBLE PRECISION NOT NULL DEFAULT 1.0,
                is_default INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
              )`, () => {
                run(`CREATE TABLE IF NOT EXISTS goals (
                  id SERIAL PRIMARY KEY,
                  date VARCHAR(50) NOT NULL,
                  title VARCHAR(500) NOT NULL,
                  desired_completion_date VARCHAR(50),
                  content TEXT,
                  status VARCHAR(20) DEFAULT 'active',
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )`, () => {
                run(`CREATE TABLE IF NOT EXISTS debt_repayments (
                  id SERIAL PRIMARY KEY,
                  debt_id INTEGER NOT NULL,
                  payment_date VARCHAR(50) NOT NULL,
                  amount DOUBLE PRECISION NOT NULL,
                  receipt_number VARCHAR(20),
                  seller_name VARCHAR(255),
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )`, () => {
                run('ALTER TABLE income ADD COLUMN IF NOT EXISTS seller_name VARCHAR(255)', () => {});
                run('ALTER TABLE debts ADD COLUMN IF NOT EXISTS seller_name VARCHAR(255)', () => {});
                db.get('SELECT id FROM configuration WHERE id = 1', [], (err, row) => {
                  if (!err && !row) {
                    db.run('INSERT INTO configuration (id, app_name) VALUES (1, ?)', ['Shop Accountant'], () => {});
                  }
                  db.get('SELECT id FROM currencies WHERE code = ?', ['FCFA'], (e, r) => {
                    if (!e && !r) {
                      db.run('INSERT INTO currencies (code, name, symbol, conversion_rate_to_fcfa, is_default) VALUES (?, ?, ?, ?, ?)', ['FCFA', 'Central African CFA Franc', 'FCFA', 1.0, 1], () => {});
                    }
                    console.log('PostgreSQL schema ready');
                    createDefaultAdmin();
                    if (done) done();
                  });
                });
              });
            });
          });
        });
      });
    });
  });
  });
});
}

function createDefaultAdmin() {
  const adminUsername = 'admin1234';
  const adminPassword = 'admin4321';
  db.get('SELECT id FROM users WHERE username = ?', [adminUsername], (err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync(adminPassword, 10);
      db.run(
        `INSERT INTO users (username, full_name, phone, email, password) VALUES (?, ?, ?, ?, ?)`,
        [adminUsername, 'Administrator', '', 'admin@shopaccountant.com', hashedPassword]
      );
      console.log('Default admin created');
    }
  });
}

/* ================= ROUTES (mounted after DB init) ================= */

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK' });
});

/* ================= SERVE REACT BUILD ================= */

const frontendBuildPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendBuildPath, 'index.html'));
  });
}

/* ================= START SERVER ================= */

db.init((err) => {
  if (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  }
  console.log('Connected to PostgreSQL');
  function startServer() {
    app.use('/api/users', require('./routes/userRoutes'));
    app.use('/api/income', require('./routes/incomeRoutes'));
    app.use('/api/expenses', require('./routes/expensesRoutes'));
    app.use('/api/purchases', require('./routes/purchasesRoutes'));
    app.use('/api/stock-deficiency', require('./routes/stockDeficiencyRoutes'));
    app.use('/api/configuration', require('./routes/configurationRoutes'));
    app.use('/api/currencies', require('./routes/currencyRoutes'));
    app.use('/api/backup', require('./routes/backupRoutes'));
    app.use('/api/debts', require('./routes/debtRoutes'));
    app.use('/api/debt-repayments', require('./routes/debtRepaymentRoutes'));
    app.use('/api/goals', require('./routes/goalsRoutes'));
    app.listen(PORT, HOST, () => {
      console.log(`Server running at http://${HOST}:${PORT}`);
      if (allowedOrigins.length) console.log('CORS allowed for frontend(s):', allowedOrigins.join(', '));
    });
  }
  initPostgresSchema(startServer);
});

process.on('SIGINT', () => {
  db.close(() => process.exit(0));
});

module.exports = { app, db };

// cSpell:enable
