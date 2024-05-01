import config from 'config';
import mysql from 'mysql2/promise';
import Utils from './Utils.js'

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
    });
  }

  this.getUser = async (username) => {
    let query = 'SELECT * FROM accounts WHERE ? LIMIT 1';
    let [rows, fields] = await self.pool.query(query, [{ username: username }]);
    if (rows[0]) {
      return rows[0];
    }
  }

  this.saveAccessTokenForUser = async (username, access_token, expire_timestamp) => {
    let query = "SELECT id FROM accounts WHERE ?";
    let [rows, fields] = await self.pool.query(query, [{ username: username }]);

    if (!rows[0]) {
      query = 'INSERT INTO accounts SET ?';
      await self.pool.query(query, [{
        username: username,
        access_token: access_token,
        access_token_expire_timestamp: expire_timestamp
      }]);
    }
    else {
      let query = 'UPDATE accounts SET ? WHERE ?';
      await self.pool.query(query, [
        { access_token: access_token, access_token_expire_timestamp: expire_timestamp },
        { username: username }
      ]);
    }
  }

  this.saveRefreshTokenForUser = async (username, refresh_token) => {
    let query = "SELECT id FROM accounts WHERE ?";
    let [rows, fields] = await self.pool.query(query, [{ username: username }]);

    if (!rows[0]) {
      query = 'INSERT INTO accounts SET ?';
      await self.pool.query(query, [{
        username: username,
        refresh_token: refresh_token,
        last_refreshed: Utils.getUnixTime()
      }])
    }
    else {
      let query = 'UPDATE accounts SET ? WHERE ?';
      await self.pool.query(query, [
        { refresh_token: refresh_token, last_refreshed: Utils.getUnixTime() },
        { username: username }
      ]);
    }
  }

  this.clearRefreshTokenForUser = async(username) => {
    let query = 'UPDATE accounts SET ? WHERE ?';
    await self.pool.query(query, [
      {refresh_token: "", last_refreshed: 0},
      {username: username}
    ]);
  }

  this.getOldestTokens = async(count) => {
    let query = `SELECT * FROM accounts WHERE last_refreshed != 0 ORDER BY last_refreshed ASC LIMIT ${count}`;
    let [rows, fields] = await self.pool.query(query);
    return rows;
  }



  this.createConnections();
}

export default DBController