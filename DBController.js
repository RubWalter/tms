import config from 'config';
import mysql from 'mysql2/promise';
import Utils from './Utils.js';
import fs from 'fs';

function DBController() {
  let self = this;

  this.pool;

  this.createConnections = async () => {
    console.log('Creating mysql pool');

    // Create the connection pool. The pool-specific settings are the defaults
    self.pool = mysql.createPool({
      host: config.get('db.host'),
      user: config.get('db.username'),
      password: config.get('db.password'),
      database: config.get('db.database'),
      port: config.get('db.port'),
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 10, // max idle connections, the default value is the same as `connectionLimit`
      idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      multipleStatements: true
    });
  }

  this.getUser = async (username, provider) => {
    let query = 'SELECT * FROM accounts WHERE ? AND ? LIMIT 1';
    let [rows, fields] = await self.pool.query(query, [{ username: username }, {provider: provider}]);
    if (rows[0]) {
      return rows[0];
    }
  }

  this.saveAccessTokenForUser = async (username, provider, access_token, expire_timestamp) => {
    let query = "SELECT id FROM accounts WHERE ? AND ?";
    let [rows, fields] = await self.pool.query(query, [{ username: username }, { provider: provider }]);

    if (!rows[0]) {
      query = 'INSERT INTO accounts SET ?';
      await self.pool.query(query, [{
        username: username,
        provider: provider,
        access_token: access_token,
        access_token_expire_timestamp: expire_timestamp
      }]);
    }
    else {
      let query = 'UPDATE accounts SET ? WHERE ? AND ?';
      await self.pool.query(query, [
        { access_token: access_token, access_token_expire_timestamp: expire_timestamp },
        { username: username },
        { provider: provider }
      ]);
    }
  }

  this.saveRefreshTokenForUser = async (username, provider, refresh_token) => {
    let query = "SELECT id FROM accounts WHERE ? AND ?";
    let [rows, fields] = await self.pool.query(query, [{ username: username }, { provider: provider }]);

    if (!rows[0]) {
      query = 'INSERT INTO accounts SET ?';
      await self.pool.query(query, [{
        username: username,
        provider: provider,
        refresh_token: refresh_token,
        last_refreshed: Utils.getUnixTime()
      }])
    }
    else {
      let query = 'UPDATE accounts SET ? WHERE ? AND ?';
      await self.pool.query(query, [
        { refresh_token: refresh_token, last_refreshed: Utils.getUnixTime() },
        { username: username },
        { provider: provider }
      ]);
    }
  }

  this.clearRefreshTokenForUser = async (username, provider) => {
    let query = 'UPDATE accounts SET ? WHERE ? AND ?';
    await self.pool.query(query, [
      { refresh_token: "", last_refreshed: 0 },
      { username: username },
      { provider: provider }
    ]);
  }

  this.getOldestTokens = async(count) => {
    let query = `SELECT * FROM accounts WHERE provider <> 'nk' AND last_refreshed != 0 ORDER BY last_refreshed ASC LIMIT ${count}`;
    let [rows, fields] = await self.pool.query(query);
    return rows;
  }

  this.isTableAvailable = async (tableName) => {
    let query = 'SELECT * FROM information_schema.tables WHERE ? AND ? LIMIT 1;'
    let [rows, fields] = await self.pool.query(query, [
      {
        table_schema: config.get('db.database')
      },
      {
        table_name : tableName
      }
    ])
    return (rows.length > 0);
  }

  this.fixMigrationMissing = async () => {
    let query = fs.readFileSync('sql/fix-missing-migration.sql', 'utf8');
    await self.pool.query(query);
  }

  this.getCurrentMigrationIndex = async () => {
    let query = "SELECT migration_index FROM migrations LIMIT 1";
    let [rows, fields] = await self.pool.query(query);
    if (rows.length > 0) {
      return rows[0].migration_index;
    }
  }

  this.runMigration = async (migrationIndex) => {
    let migrationPath = `migrations/${migrationIndex}.sql`;
    let query = fs.readFileSync(migrationPath, 'utf8');
    try {
      await self.pool.query(query);
    } 
    catch (error) {
      console.log('Migration error, exiting.');
      console.log(error);
      process.exit();
    }
  }

  this.createConnections();
}

export default DBController