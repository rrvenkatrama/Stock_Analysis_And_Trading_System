const mysql = require('mysql2/promise');
const cfg   = require('../config/env');

const pool = mysql.createPool({
  host:               cfg.db.host,
  port:               cfg.db.port,
  user:               cfg.db.user,
  password:           cfg.db.password,
  database:           cfg.db.database,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           'Z',
});

async function query(sql, params = []) {
  // pool.query (text protocol) instead of pool.execute (binary/prepared) —
  // mysql2 binary protocol has edge-case bugs with LIMIT ?, DATE_SUB, etc on MySQL 8.4
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function insert(sql, params) {
  const [result] = await pool.query(sql, params);
  return result.insertId;
}

async function log(level, module, message, meta = null) {
  try {
    await insert(
      'INSERT INTO system_log (level, module, message, meta) VALUES (?, ?, ?, ?)',
      [level, module, message, meta ? JSON.stringify(meta) : null]
    );
  } catch (_) {
    // never throw from logger
  }
}

module.exports = { pool, query, queryOne, insert, log };
