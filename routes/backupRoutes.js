const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const storage = require('../storage');

const uploadsDir = path.join(storage.uploadsDir, 'backups');
storage.ensureLocalDir();
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'backup-' + uniqueSuffix + '.json');
  }
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are allowed!'));
    }
  }
});

// Get all table names (PostgreSQL)
const getAllTables = () => {
  return new Promise((resolve, reject) => {
    db.all("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'", [], (err, rows) => {
      if (err) reject(err);
      else resolve((rows || []).map(row => row.name));
    });
  });
};

// Get all data from a table
const getTableData = (tableName) => {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

// Create backup
router.get('/create', async (req, res) => {
  try {
    const tables = await getAllTables();
    const backupData = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      tables: {}
    };

    // Get data from each table
    for (const table of tables) {
      try {
        const data = await getTableData(table);
        backupData.tables[table] = data;
      } catch (error) {
        console.error(`Error backing up table ${table}:`, error);
        // Continue with other tables even if one fails
        backupData.tables[table] = [];
      }
    }

    // Create backup file
    const backupFileName = `shop-accountant-backup-${Date.now()}.json`;
    const backupFilePath = path.join(uploadsDir, backupFileName);

    fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), 'utf8');

    // Send file to client
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFileName}"`);
    
    const fileStream = fs.createReadStream(backupFilePath);
    fileStream.pipe(res);

    // Clean up file after sending (optional - you might want to keep it)
    fileStream.on('end', () => {
      // Optionally delete the file after sending
      // fs.unlinkSync(backupFilePath);
    });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating backup: ' + error.message
    });
  }
});

// Restore from backup
router.post('/restore', upload.single('backupFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No backup file provided'
    });
  }

  try {
    // Read backup file
    const backupFilePath = req.file.path;
    const backupContent = fs.readFileSync(backupFilePath, 'utf8');
    const backupData = JSON.parse(backupContent);

    // Validate backup structure
    if (!backupData.tables || typeof backupData.tables !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Invalid backup file format'
      });
    }

    // Start transaction
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      try {
        // Clear existing data from all tables (except keep structure)
        const tables = Object.keys(backupData.tables);
        
        for (const table of tables) {
          // Delete all data from table
          db.run(`DELETE FROM ${table}`, (err) => {
            if (err) {
              console.error(`Error clearing table ${table}:`, err);
            }
          });
        }

        // Wait for deletions to complete, then insert data
        db.run('COMMIT', async (err) => {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Error during restore: ' + err.message
            });
          }

          // Now insert backup data
          db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            let insertCount = 0;
            let totalInserts = 0;

            // Count total inserts needed
            for (const table of tables) {
              totalInserts += backupData.tables[table].length;
            }

            if (totalInserts === 0) {
              db.run('COMMIT', (err) => {
                if (err) {
                  return res.status(500).json({
                    success: false,
                    message: 'Error completing restore: ' + err.message
                  });
                }

                // Clean up uploaded file
                fs.unlinkSync(backupFilePath);

                res.json({
                  success: true,
                  message: 'Backup restored successfully (no data to restore)'
                });
              });
              return;
            }

            // Insert data for each table
            for (const table of tables) {
              const tableData = backupData.tables[table];
              
              if (tableData.length === 0) continue;

              // Get column names from first row
              const columns = Object.keys(tableData[0]);
              const placeholders = columns.map(() => '?').join(', ');
              const columnNames = columns.join(', ');

              for (const row of tableData) {
                const values = columns.map(col => {
                  const value = row[col];
                  // Handle null values
                  if (value === null || value === undefined) {
                    return null;
                  }
                  return value;
                });

                db.run(
                  `INSERT INTO ${table} (${columnNames}) VALUES (${placeholders})`,
                  values,
                  function(err) {
                    if (err) {
                      console.error(`Error inserting into ${table}:`, err);
                    }
                    insertCount++;

                    // When all inserts are done
                    if (insertCount === totalInserts) {
                      db.run('COMMIT', (err) => {
                        if (err) {
                          return res.status(500).json({
                            success: false,
                            message: 'Error completing restore: ' + err.message
                          });
                        }

                        // Clean up uploaded file
                        fs.unlinkSync(backupFilePath);

                        res.json({
                          success: true,
                          message: `Backup restored successfully. Restored ${insertCount} records.`
                        });
                      });
                    }
                  }
                );
              }
            }
          });
        });
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error('Error restoring backup:', error);
    
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      success: false,
      message: 'Error restoring backup: ' + error.message
    });
  }
});

// Get backup info (without downloading)
router.get('/info', async (req, res) => {
  try {
    const tables = await getAllTables();
    const backupInfo = {
      tables: [],
      totalRecords: 0
    };

    for (const table of tables) {
      const data = await getTableData(table);
      backupInfo.tables.push({
        name: table,
        recordCount: data.length
      });
      backupInfo.totalRecords += data.length;
    }

    res.json({
      success: true,
      info: backupInfo
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error getting backup info: ' + error.message
    });
  }
});

module.exports = router;
