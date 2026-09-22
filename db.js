/**
 * Database layer: PostgreSQL pool.
 * Requires DB_HOST or DATABASE_URL to be set.
 */
function convertPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

const CONNECT_FAIL_RE = /starting up|ECONNREFUSED|ETIMEDOUT|timeout expired|too many clients|remaining connection slots|the database system is shutting down|cannot connect now|sorry, too many clients/i;
const DEAD_CONN_RE = /ECONNRESET|connection terminated|server closed the connection|Connection terminated|Client has already been connected|Connection terminated unexpectedly/i;

function isConnectFail(err) {
  if (!err) return false;
  const code = err.code || '';
  if (['57P03', '53300', '08000', '08001', '08004', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  return CONNECT_FAIL_RE.test(err.message || '') || CONNECT_FAIL_RE.test(code);
}

function isDeadConnection(err) {
  if (!err) return false;
  const code = err.code || '';
  if (['57P01', '57P02', '08003', '08006', 'ECONNRESET'].includes(code)) {
    return true;
  }
  return DEAD_CONN_RE.test(err.message || '');
}

function isRetryable(err, sql) {
  if (isConnectFail(err)) return true;
  if (!isDeadConnection(err)) return false;
  const head = String(sql || '').trim().toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('SHOW') || head.startsWith('WITH');
}

function poolConfig() {
  const ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
  const shared = {
    ssl,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  };
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ...shared };
  }
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ...shared,
  };
}

let pool;
let ready = false;

function prepareSql(sql) {
  const pgSql = convertPlaceholders(sql);
  const trimmed = sql.trim().toUpperCase();
  const isInsert = trimmed.startsWith('INSERT') && !trimmed.includes('RETURNING');
  return isInsert ? pgSql.replace(/;\s*$/, '') + ' RETURNING id' : pgSql;
}

function queryOn(target, sql, params, cb, attempt) {
  const finalSql = prepareSql(sql);
  target.query(finalSql, params || [], (err, res) => {
    if (err && isRetryable(err, sql) && attempt < 3) {
      const delay = 250 * Math.pow(2, attempt);
      return setTimeout(() => queryOn(target, sql, params, cb, attempt + 1), delay);
    }
    cb(err, res);
  });
}

function makeApi(queryTarget) {
  return {
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      if (!callback) callback = () => {};
      if (!queryTarget && !pool) return callback(new Error('Database not initialized'));
      queryOn(queryTarget || pool, sql, params, (err, res) => {
        const ctx = {};
        if (res && res.rows && res.rows[0] && res.rows[0].id != null) ctx.lastID = res.rows[0].id;
        callback.call(ctx, err);
      }, 0);
    },
    get(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      if (!callback) callback = () => {};
      if (!queryTarget && !pool) return callback(new Error('Database not initialized'));
      queryOn(queryTarget || pool, sql, params, (err, res) => {
        if (err) return callback(err);
        callback(null, res.rows ? res.rows[0] : null);
      }, 0);
    },
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      if (!callback) callback = () => {};
      if (!queryTarget && !pool) return callback(new Error('Database not initialized'));
      queryOn(queryTarget || pool, sql, params, (err, res) => {
        if (err) return callback(err);
        callback(null, res.rows || []);
      }, 0);
    },
  };
}

const defaultApi = makeApi(null);

function run(sql, params, callback) {
  return defaultApi.run(sql, params, callback);
}

function get(sql, params, callback) {
  return defaultApi.get(sql, params, callback);
}

function all(sql, params, callback) {
  return defaultApi.all(sql, params, callback);
}

function patchExports(api) {
  module.exports.run = api.run;
  module.exports.get = api.get;
  module.exports.all = api.all;
}

/**
 * Hold one pooled connection for the duration of fn() plus in-flight queries
 * started from it, so BEGIN/COMMIT stay on the same session.
 */
function serialize(fn) {
  if (!pool) {
    fn();
    return;
  }
  pool.connect((err, client, release) => {
    if (err) {
      console.error('PostgreSQL serialize connect failed:', err.message);
      fn();
      return;
    }

    let inFlight = 0;
    let finishedSync = false;
    let released = false;

    const finishIfIdle = () => {
      if (finishedSync && inFlight === 0 && !released) {
        released = true;
        patchExports(defaultApi);
        release();
      }
    };

    const tracked = makeApi(client);
    const wrap = (method) => (sql, params, callback) => {
      if (typeof params === 'function') { callback = params; params = []; }
      inFlight++;
      method(sql, params, function wrappedCb(err, row) {
        try {
          if (callback) callback.call(this, err, row);
        } finally {
          inFlight--;
          finishIfIdle();
        }
      });
    };

    patchExports({
      run: wrap(tracked.run),
      get: wrap(tracked.get),
      all: wrap(tracked.all),
    });

    try {
      fn();
    } finally {
      finishedSync = true;
      finishIfIdle();
    }
  });
}

function close(callback) {
  ready = false;
  if (!pool) {
    if (callback) callback();
    return;
  }
  const p = pool;
  pool = null;
  p.end(() => {
    if (callback) callback();
  });
}

function ping(callback) {
  if (!pool) return callback(new Error('Database not initialized'));
  pool.query('SELECT 1 AS ok', (err) => callback(err || null));
}

function connectWithRetry(callback, attempt) {
  const { Pool } = require('pg');
  if (pool) {
    try { pool.end(() => {}); } catch (_) { /* ignore */ }
  }
  pool = new Pool(poolConfig());
  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message);
  });

  pool.query('SELECT 1 AS ok', (err) => {
    if (err) {
      const next = (attempt || 0) + 1;
      const delay = Math.min(1000 * Math.pow(2, Math.min(attempt || 0, 5)), 15000);
      console.error(
        `Database connection failed: ${err.message} (retry ${next} in ${Math.round(delay / 1000)}s)`
      );
      try { pool.end(() => {}); } catch (_) { /* ignore */ }
      pool = null;
      return setTimeout(() => connectWithRetry(callback, next), delay);
    }
    ready = true;
    callback(null);
  });
}

function init(callback) {
  if (ready && pool) return callback(null);

  if (!process.env.DB_HOST && !process.env.DATABASE_URL) {
    return callback(new Error('Database not configured: set DB_HOST or DATABASE_URL'));
  }

  connectWithRetry(callback, 0);
}

module.exports = {
  init,
  run,
  get,
  all,
  serialize,
  close,
  ping,
  get isPg() { return true; },
  get client() { return pool; },
  get ready() { return ready; },
};
