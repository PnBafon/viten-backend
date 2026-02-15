/**
 * Database layer: PostgreSQL only.
 * Requires DB_HOST or DATABASE_URL to be set.
 */
function convertPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

let _run, _get, _all, _serialize, _close, _client;
let ready = false;

function run(sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = []; }
  if (!_run) return callback(new Error('Database not initialized'));
  _run(sql, params, callback);
}

function get(sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = []; }
  if (!_get) return callback(new Error('Database not initialized'));
  _get(sql, params, callback);
}

function all(sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = []; }
  if (!_all) return callback(new Error('Database not initialized'));
  _all(sql, params, callback);
}

function serialize(fn) {
  if (_serialize) _serialize(fn);
  else fn();
}

function close(callback) {
  if (_close) _close(callback);
  else if (callback) callback();
}

function init(callback) {
  if (ready) return callback(null);

  if (!process.env.DB_HOST && !process.env.DATABASE_URL) {
    return callback(new Error('Database not configured: set DB_HOST or DATABASE_URL'));
  }

  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
  _client = client;
  client.on('error', (err) => {
    console.error('PostgreSQL client error:', err.message);
  });
  client.connect((err) => {
    if (err) return callback(err);
    ready = true;

    _run = (sql, params, cb) => {
      const pgSql = convertPlaceholders(sql);
      const isInsert = sql.trim().toUpperCase().startsWith('INSERT') && !sql.toUpperCase().includes('RETURNING');
      const finalSql = isInsert ? pgSql.replace(/;\s*$/, '') + ' RETURNING id' : pgSql;
      client.query(finalSql, params || [], (err, res) => {
        const ctx = {};
        if (res && res.rows && res.rows[0] && res.rows[0].id != null) ctx.lastID = res.rows[0].id;
        cb.call(ctx, err);
      });
    };
    _get = (sql, params, cb) => {
      const pgSql = convertPlaceholders(sql);
      client.query(pgSql, params || [], (err, res) => {
        if (err) return cb(err);
        cb(null, res.rows ? res.rows[0] : null);
      });
    };
    _all = (sql, params, cb) => {
      const pgSql = convertPlaceholders(sql);
      client.query(pgSql, params || [], (err, res) => {
        if (err) return cb(err);
        cb(null, res.rows || []);
      });
    };
    _serialize = (fn) => {
      const queue = [];
      const runOne = () => {
        if (queue.length === 0) return;
        const [method, sql, params, cb] = queue.shift();
        const pgSql = convertPlaceholders(sql);
        const isInsert = sql.trim().toUpperCase().startsWith('INSERT') && !sql.toUpperCase().includes('RETURNING');
        const finalSql = isInsert ? pgSql.replace(/;\s*$/, '') + ' RETURNING id' : pgSql;
        client.query(finalSql, params || [], (err, res) => {
          const ctx = {};
          if (res && res.rows && res.rows[0] && res.rows[0].id != null) ctx.lastID = res.rows[0].id;
          if (method === 'run') cb.call(ctx, err);
          else if (method === 'get') cb(err, err ? null : (res && res.rows ? res.rows[0] : null));
          else cb(err, err ? null : (res && res.rows || []));
          setImmediate(runOne);
        });
      };
      const origRun = _run, origGet = _get, origAll = _all;
      _run = (sql, params, cb) => { queue.push(['run', sql, params, cb]); if (queue.length === 1) runOne(); };
      _get = (sql, params, cb) => { queue.push(['get', sql, params, cb]); if (queue.length === 1) runOne(); };
      _all = (sql, params, cb) => { queue.push(['all', sql, params, cb]); if (queue.length === 1) runOne(); };
      fn();
      _run = origRun; _get = origGet; _all = origAll;
      if (queue.length === 0) runOne = () => {};
    };
    _close = (cb) => client.end(() => { ready = false; if (cb) cb(); });
    callback(null);
  });
}

module.exports = {
  init,
  run,
  get,
  all,
  serialize,
  close,
  get isPg() { return true; },
  get client() { return _client; }
};
