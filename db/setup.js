// Run once: node db/setup.js
// Creates the database and all tables

const fs   = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function setup() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'stocktrader',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  try {
    await conn.query(sql);
    console.log('Database and tables created successfully.');
  } catch (err) {
    console.error('Setup failed:', err.message);
  } finally {
    await conn.end();
  }
}

setup();
