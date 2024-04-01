# Token Management System (TMS)

## A centralised system to manage PTC tokens

Keep track of your PTC tokens so you don't have to make unncessary authentation requests.

### Requirements:

- Node.js (tested with Node.js 21 but earlier versions should work).
- A 3rd party tool to get the `login_code` from PTC. Currently the only working public tool is [Xilriws](https://github.com/UnownHash/Xilriws-Public).
- MySQL 8.

### Instructions:

- `git clone https://github.com/RubWalter/tms.git`
- `cd tms && npm i`
- Create a new database in MySQL and import `sql/create.sql`
- Make changes to `config/default.json`:
    -  Fill in your database details
    -  `ptc_auth_url`: your Xilriws url
    - `refresh_token_keep_alive.enabled`: set to `true` to renew refresh tokens automatically before it expires.
    - `refresh_token_keep_alive.max_age_days`: only renew tokens older than xx days.
    - Please leave `interval_seconds`, `request_sleep_seconds` and `tokens_per_interval` as they are unless you have read the code and know what you're doing.
- Run it: `node index.js`
- If your MITM software asks for a url, use `http://IP_ADDRESS:9999/access_token`

It's recommeded to run this via [pm2](https://pm2.keymetrics.io/).

`pm2 start index.js --name tms`
