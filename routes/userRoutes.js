const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');

// Login route
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Username and password are required' 
    });
  }

  // Find user by username
  db.get(
    'SELECT * FROM users WHERE username = ?',
    [username],
    (err, user) => {
      if (err) {
        return res.status(500).json({ 
          success: false, 
          message: 'Database error' 
        });
      }

      if (!user) {
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid username or password' 
        });
      }

      // Compare password
      const isPasswordValid = bcrypt.compareSync(password, user.password);
      
      if (!isPasswordValid) {
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid username or password' 
        });
      }

      // Return user data (excluding password)
      const { password: _, ...userWithoutPassword } = user;
      res.json({
        success: true,
        message: 'Login successful',
        user: userWithoutPassword
      });
    }
  );
});

// Signup route
router.post('/signup', (req, res) => {
  const { username, fullName, phone, email, password, repeatPassword } = req.body;

  // Validation
  if (!username || !fullName || !email || !password || !repeatPassword) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields are required' 
    });
  }

  if (password !== repeatPassword) {
    return res.status(400).json({ 
      success: false, 
      message: 'Passwords do not match' 
    });
  }

  if (password.length < 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'Password must be at least 6 characters long' 
    });
  }

  // Check if username or email already exists
  db.get(
    'SELECT id FROM users WHERE username = ? OR email = ?',
    [username, email],
    (err, existingUser) => {
      if (err) {
        return res.status(500).json({ 
          success: false, 
          message: 'Database error' 
        });
      }

      if (existingUser) {
        return res.status(409).json({ 
          success: false, 
          message: 'Username or email already exists' 
        });
      }

      // Hash password
      const hashedPassword = bcrypt.hashSync(password, 10);

      // Insert new user
      db.run(
        `INSERT INTO users (username, full_name, phone, email, password) 
         VALUES (?, ?, ?, ?, ?)`,
        [username, fullName, phone || '', email, hashedPassword],
        function(err) {
          if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
              return res.status(409).json({ 
                success: false, 
                message: 'Username or email already exists' 
              });
            }
            return res.status(500).json({ 
              success: false, 
              message: 'Error creating account' 
            });
          }

          res.json({
            success: true,
            message: 'Account created successfully',
            userId: this.lastID
          });
        }
      );
    }
  );
});

// Get all users route
router.get('/', (req, res) => {
  db.all(
    'SELECT id, username, full_name, phone, email, created_at FROM users ORDER BY created_at DESC',
    [],
    (err, users) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Database error'
        });
      }

      res.json({
        success: true,
        users: users || []
      });
    }
  );
});

// Update user route
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { username, fullName, phone, email, password } = req.body;

  // Check if user exists
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if username or email is being changed and already exists
    if (username || email) {
      const checkQuery = username && email
        ? 'SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?'
        : username
        ? 'SELECT id FROM users WHERE username = ? AND id != ?'
        : 'SELECT id FROM users WHERE email = ? AND id != ?';
      
      const checkParams = username && email
        ? [username, email, id]
        : username
        ? [username, id]
        : [email, id];

      db.get(checkQuery, checkParams, (err, existingUser) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: 'Database error'
          });
        }

        if (existingUser) {
          return res.status(409).json({
            success: false,
            message: 'Username or email already exists'
          });
        }

        updateUser();
      });
    } else {
      updateUser();
    }

    function updateUser() {
      const updates = [];
      const values = [];

      if (username) {
        updates.push('username = ?');
        values.push(username);
      }
      if (fullName) {
        updates.push('full_name = ?');
        values.push(fullName);
      }
      if (phone !== undefined) {
        updates.push('phone = ?');
        values.push(phone);
      }
      if (email) {
        updates.push('email = ?');
        values.push(email);
      }
      if (password) {
        if (password.length < 6) {
          return res.status(400).json({
            success: false,
            message: 'Password must be at least 6 characters long'
          });
        }
        updates.push('password = ?');
        values.push(bcrypt.hashSync(password, 10));
      }

      if (updates.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }

      values.push(id);

      db.run(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
        values,
        function(err) {
          if (err) {
            return res.status(500).json({
              success: false,
              message: 'Error updating user'
            });
          }

          // Get updated user
          db.get(
            'SELECT id, username, full_name, phone, email, created_at FROM users WHERE id = ?',
            [id],
            (err, updatedUser) => {
              if (err) {
                return res.status(500).json({
                  success: false,
                  message: 'Database error'
                });
              }

              res.json({
                success: true,
                message: 'User updated successfully',
                user: updatedUser
              });
            }
          );
        }
      );
    }
  });
});

// Delete user route
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  // Check if user exists
  db.get('SELECT id FROM users WHERE id = ?', [id], (err, user) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Database error'
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete user
    db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: 'Error deleting user'
        });
      }

      res.json({
        success: true,
        message: 'User deleted successfully'
      });
    });
  });
});

module.exports = router;
