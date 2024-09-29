import express from 'express';
import pkceChallenge from "pkce-challenge";
import axios from 'axios';
import querystring from 'querystring';
import config from 'config';
import DBController from './DBController.js';
import Utils from './Utils.js'
import fs from 'fs'
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
(async () => {
  let userAgentHeader = {
    headers: {
      'User-Agent': 'PokmonGO/2 CFNetwork/1410.1 Darwin/22.6.0'
    }
  };
  const ptc_auth_url = config.get('ptc_auth_url');
  const appPort = config.get('port');
  let isKeepingAlive = false;
  let proxyIndex = 0;
  let proxies = [];
  let ongoingRefreshingAccounts = {};
  try {
    proxies = fs.readFileSync('config/proxies.txt', 'utf8').split('\n');
  }
  catch(e) {
    console.log(`Unable to parse proxies.txt, will not use any proxy`);
  }
  
  //remove empty lines
  proxies = proxies.filter(proxy => {
    if (proxy.trim()) {
      console.log(`Proxy: ${proxy}`);
      return true;
    }
    return false;
  });

  function nextProxy() {
    if (proxies.length == 0) {
      return "";
    }
    let proxy = proxies[proxyIndex];
    proxyIndex = (proxyIndex + 1) % proxies.length;
    return proxy;
  }

  function axiosWithProxy(proxy) {
    let httpAgent = new HttpProxyAgent(proxy);
    let httpsAgent = new HttpsProxyAgent(proxy);
    let nextAxios = axios.create({
      httpAgent: httpAgent,
      httpsAgent: httpsAgent
    });
    return nextAxios;
  }

  //return an axios instance with proxy if available, otherwise a standard axios
  function nextAxios() {
    let proxy = nextProxy();
    if (!proxy) return axios;
    console.log(`Using proxy ${proxy} for the next request`);
    return axiosWithProxy(proxy);
  }

  async function keepAliveToken(numberOfTokens) {
    //avoid running multiple keep alive functions at once, due to misconfiguration or bad proxies
    if (isKeepingAlive) {
      console.log('Another instance of keep alive is running, aborting. Please check your default.json to make sure the values are appropriately configured and all the proxies are fast.')
      return;
    }    
    isKeepingAlive = true;      
    console.log('Background refreshing started');
    let sleepSecond = config.get('refresh_token_keep_alive.request_sleep_seconds');
    let users = await dbController.getOldestTokens(config.get('refresh_token_keep_alive.tokens_per_interval'));
    for (let i = 0; i < users.length; ++i) {
      let user = users[i];
      if (user.refresh_token) {
        let daysSinceLastRefresh = Math.round((Utils.getUnixTime() - user.last_refreshed) / 86400 * 100) / 100;
        if (daysSinceLastRefresh < 30 && daysSinceLastRefresh > config.get('refresh_token_keep_alive.max_age_days')) {
          await refreshToken(user);
          await new Promise(r => setTimeout(r, sleepSecond * 1000));
        }
      }
    }
    isKeepingAlive = false;
    console.log('Background refreshing ended');
  }

  function lockAccount(username, provider) {
    ongoingRefreshingAccounts[`${username}-${provider}`] = 1;
  }

  function unlockAccount(username, provider) {
    delete(ongoingRefreshingAccounts[`${username}-${provider}`]);
  }

  function isAccountLocked(username, provider) {
    if (ongoingRefreshingAccounts[`${username}-${provider}`]) return true;
    return false;
  }

  async function refreshToken(user) {
    console.log(`[${user.username}][${user.provider}] Trying refresh token`);

    if (user.provider == 'nk') {
      console.log(`[${user.username}][${user.provider}] Refreshing token for NK is not supported`);
      return;
    }

    //prevent 1 account being used by multiple devices at the same time
    if (isAccountLocked(user.username, user.provider)) {
      console.log(`[${user.username}][${user.provider}] is currently refreshing its token, ignore this attempt`);
      return;
    }

    lockAccount(user.username, user.provider);

    let params, url;
    if (user.provider == 'ptc') {
      params = {
        client_id: 'pokemon-go',
        refresh_token: user.refresh_token,
        grant_type: "refresh_token",
        redirect_uri: "https://www.pokemongolive.com/dl?app=pokemongo&dl_action=OPEN_LOGIN"
      }

      url = 'https://access.pokemon.com/oauth2/token';
    }
    else if (user.provider == 'nk') {
      params = {
        client_id: "pokemon-go",
        client_secret: "AoPUaDBd3Jn3ah4NIDQRezdPzUfan3Lz",
        grant_type: "refresh_token",
        refresh_token: user.refresh_token
      }
      url = 'https://niantic.api.kws.superawesome.tv/oauth/token';
    }

    let body;
    try {
      let nAxios = nextAxios();
      body = await nAxios.post(url, querystring.stringify(params), userAgentHeader);
      if (body.data && body.data.access_token && body.data.refresh_token) {
        let access_token = body.data.access_token;
        let refresh_token = body.data.refresh_token;
        let expire_timestamp = Utils.getUnixTime() + body.data.expires_in;
        console.log(`[${user.username}][${user.provider}] Refreshed token successfully`);

        console.log(`[${user.username}][${user.provider}] Saving access token`);
        await dbController.saveAccessTokenForUser(user.username, user.provider, access_token, expire_timestamp);

        console.log(`[${user.username}][${user.provider}]Saving new refresh token`);
        await dbController.saveRefreshTokenForUser(user.username, user.provider, refresh_token);
        unlockAccount(user.username, user.provider);
        return {
          access_token: access_token,
          provider: user.provider
        };
      }
      else {
        unlockAccount(user.username, user.provider);
        console.log(`[${user.username}][${user.provider}] Unabled to refresh token`);
      }
    }
    catch (error) {
      //remove refresh token if it's no longer valid
      if (error.response && error.response.data && (error.response.data.error == 'invalid_grant' || error.response.data.error == 'token_inactive')) {
        await dbController.clearRefreshTokenForUser(user.username, user.provider);
        console.log(`[${user.username}][${user.provider}] Refresh token is invalid, clearing from database`);
      }
      else {
        console.log(`[${user.username}][${user.provider}] Unabled to refresh token`);
        console.log(error);
      }
      unlockAccount(user.username, user.provider);
      return;
    }
  }

  async function migrateDB() {
    let availableMigrations = fs.readdirSync('migrations');
    availableMigrations = availableMigrations.filter(file => {
      return file.includes('.sql');
    });

    availableMigrations = availableMigrations.map(file => {
      let [index] = file.split('.');
      index = parseInt(index);
      return index;
    });

    availableMigrations.sort((a,b) => {
      return a - b;
    });

    //if accounts table is missing, this is the first run
    let isAccountsTableAvailable = await dbController.isTableAvailable('accounts');
    
    if (!isAccountsTableAvailable) {
      await dbController.runMigration(0);
    }

    //handle missing migration index (first version of tms)
    let isMigrationsTableAvailable = await dbController.isTableAvailable('migrations');

    if (!isMigrationsTableAvailable) {
      //create migration table, set migration index to 0;
      await dbController.fixMigrationMissing();
    }

    let currentMigrationIndex = await dbController.getCurrentMigrationIndex();

    if (currentMigrationIndex === undefined) {
      console.log('Something is wrong during migration, exiting.');
      process.exit();
    }

    for (let i = 0; i < availableMigrations.length; ++i)  {
      let migrationIndex = availableMigrations[i];
      if (migrationIndex > currentMigrationIndex) {
        console.log(`Run migration index ${migrationIndex}`);
        await dbController.runMigration(migrationIndex);
      }
    }
  }
  
  let dbController = new DBController();
  await migrateDB();
  let app = new express();  
  app.use(express.json());  
  app.post('/access_token', async (req, res) => {
    let username = req.body.username;
    let password = req.body.password;
    let provider = req.body.provider;

    if (!username || !password) {
      console.log("Missing username or password!");
      res.status(500).send("Missing username or password!");
      return;
    }

    //default provider is ptc. will error out in the future if a provider is not provided
    if (!provider) {
      provider = 'ptc';
    }

    console.log(`[${username}][${provider}] Starting`);

    //check if we have existing refresh token
    let user = await dbController.getUser(username, provider);

    //reuse token if possible
    if (user && user.access_token && user.access_token_expire_timestamp > Utils.getUnixTime() + 600) {
      //return the last access_token if we have more than 5 minutes of use left
      let timeLeft = Math.floor((user.access_token_expire_timestamp - Utils.getUnixTime()) / 60);
      console.log(`[${username}] Returning existing access token with ${timeLeft} minutes left`);
      let access_token = user.access_token;
      res.json({
        access_token: access_token
      });
      return;
    }    
    else if (provider != 'nk' && user && user.refresh_token && user.last_refreshed > Utils.getUnixTime() - 30 * 86400) {
      let result = await refreshToken(user);
      if (result && result.access_token) {
        console.log(`[${username}][${provider}] Returning access token`);
        res.json({
          access_token: result.access_token,
          provider: provider
        });
        return;
      }
      else {
        res.status(500).send(`[${username}][${provider}] Unabled to refresh token`);
        return;
      }
    }
    else {
      if (provider == 'ptc') {
        console.log(`[${username}][${provider}] Getting login code`);
        let challenge = await pkceChallenge(86);

        let url = `https://access.pokemon.com/oauth2/auth?state=${Utils.randomString(24)}&scope=openid+offline+email+dob+pokemon_go+member_id+username&redirect_uri=https://www.pokemongolive.com/dl?app=pokemongo%26dl_action=OPEN_LOGIN&client_id=pokemon-go&response_type=code&code_challenge=${challenge.code_challenge}&code_challenge_method=S256`;

        let body;

        try {
          //no proxy here, not talking to ptc
          body = await axios.post(ptc_auth_url, {
            url: url,
            username: username,
            password: password,
            proxy: nextProxy()
          });
        }
        catch (error) {
          console.log(`[${username}][${provider}] PTC Auth error`);
          console.log(error);
          //pass along response error for ptc
          if (error && error.response && error.response.status) {
            let responseData = {};
            res.status(error.response.status);
            if (error.response.data) {
              responseData = error.response.data;
            }
            res.json(responseData);
            return;
          }
        }

        if (body && body.data && body.data.login_code) {
          let login_code = body.data.login_code;
          console.log(`[${username}][${provider}] Login code is ${login_code.substr(0, 10)}....`);
          console.log(`[${username}][${provider}] Exchanging for tokens`);

          let tmpParams = {
            client_id: 'pokemon-go',
            code: login_code,
            code_verifier: challenge.code_verifier,
            grant_type: 'authorization_code',
            redirect_uri: 'https://www.pokemongolive.com/dl?app=pokemongo&dl_action=OPEN_LOGIN'
          }

          let body2;

          try {
            let nAxios = nextAxios();
            body2 = await nAxios.post('https://access.pokemon.com/oauth2/token', querystring.stringify(tmpParams), userAgentHeader);

            let access_token = body2.data.access_token;
            let refresh_token = body2.data.refresh_token;
            let expire_timestamp = Utils.getUnixTime() + body2.data.expires_in;

            if (access_token) {
              if (refresh_token) {
                console.log(`[${username}][${provider}] Saving refresh token`);
                await dbController.saveRefreshTokenForUser(username, provider, refresh_token);
              }

              console.log(`[${username}][${provider}] Saving access token`);
              await dbController.saveAccessTokenForUser(username, provider, access_token, expire_timestamp);
              console.log(`[${username}][${provider}] Returning access token`);
              res.json({
                access_token: access_token
              });
              return;
            }
            else {
              console.log(`[${username}][${provider}] Unable to exchange tokens`);
            }
          }
          catch (error) {
            console.log(`[${username}][${provider}] Exchaging token error`);
            console.log(error);
          }
        }
        else {
          console.log(`[${username}][${provider}] Unable to get login code`);
        }
      }
      else if (provider == 'nk') {
        let params = {
          client_id: "pokemon-go",
          // client_secret: "AoPUaDBd3Jn3ah4NIDQRezdPzUfan3Lz",
          grant_type: "password",
          username: username,
          password: password
        }

        let body;
        try  {
          let nAxios = nextAxios();
          let headers = {};
          headers['User-Agent'] = userAgentHeader.headers['User-Agent'];
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          headers['Authorization'] = 'Basic cG9rZW1vbi1nbzpISURERU5DTElFTlRTRUNSRVQ=';

          body = await nAxios.post('https://pgorelease.nianticlabs.com/plfe/superawesomeauthproxy', params, {
            headers: headers
          });
        }
        catch (error) {
          console.log(`[${username}][${provider}] Unable to get token`);
          console.log(error);
        }

        if (body && body.data && body.data.access_token && body.data.refresh_token) {

          let access_token = body.data.access_token;
          let refresh_token = body.data.refresh_token;
          let expire_timestamp = Utils.getUnixTime() + body.data.expires_in;

          if (access_token) {
            if (refresh_token) {
              console.log(`[${username}][${provider}] Saving refresh token`);
              await dbController.saveRefreshTokenForUser(username, provider, refresh_token);
            }

            console.log(`[${username}][${provider}] Saving access token`);
            await dbController.saveAccessTokenForUser(username, provider, access_token, expire_timestamp);
            console.log(`[${username}][${provider}] Returning access token`);
            res.json({
              access_token: access_token,
              provider: provider
            });
            return;
          }
          else {
            console.log(`[${username}][${provider}] Unable to get token (2)`);
          }
        }
      }
    }
    res.json({});
  });
  
  app.listen(appPort);
  console.log(`Listening on port ${appPort}`);

  //If enabled, try to refresh 60 tokens in 5 minutes interval. That's about a maximum of 17280 tokens per day. If you need more than that, reduce the interval and sleep time between requests. Please try to be sensible and do not flood PTC with requests.  
  if (config.get('refresh_token_keep_alive.enabled')) {
    setInterval(() => {
      keepAliveToken('refresh_token_keep_alive.tokens_per_interval')
    }, config.get('refresh_token_keep_alive.interval_seconds') * 1000);
  }
})();