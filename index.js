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
  const ptc_auth_url = config.get('ptc_auth_url');
  const appPort = config.get('port');
  let proxyIndex = 0;
  let proxies = [];
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
    console.log('Background refreshing ended');
  }

  async function refreshToken(user) {
    console.log(`[${user.username}] Trying refresh token`);
    let params = {
      client_id: 'pokemon-go',
      refresh_token: user.refresh_token,
      grant_type: "refresh_token",
      redirect_uri: "https://www.pokemongolive.com/dl?app=pokemongo&dl_action=OPEN_LOGIN"
    }

    let body;
    try {
      let nAxios = nextAxios();
      body = await nAxios.post('https://access.pokemon.com/oauth2/token', querystring.stringify(params));
      if (body.data && body.data.access_token && body.data.refresh_token) {
        let access_token = body.data.access_token;
        let refresh_token = body.data.refresh_token;
        let expire_timestamp = Utils.getUnixTime() + body.data.expires_in;
        console.log(`[${user.username}] Refreshed token successfully`);

        console.log(`[${user.username}] Saving access token`);
        await dbController.saveAccessTokenForUser(user.username, access_token, expire_timestamp);

        console.log(`[${user.username}] Saving new refresh token`);
        await dbController.saveRefreshTokenForUser(user.username, refresh_token);

        return {access_token: access_token};
      }
    }
    catch (error) {
      //remove refresh token if it's no longer valid
      if (error.response && error.response.data && (error.response.data.error == 'invalid_grant' || error.response.data.error == 'token_inactive')) {
        await dbController.clearRefreshTokenForUser(user.username);
        console.log(`[${user.username}] Refresh token is invalid, clearing from database`);
      }
      else {
        console.log(`[${user.username}] Unabled to refresh token`);
        console.log(error);
      }
      return;
    }
  }
  
  let dbController = new DBController();
  let app = new express();  
  app.use(express.json());  
  app.post('/access_token', async (req, res) => {
    let username = req.body.username;
    let password = req.body.password;

    if (!username || !password) {
      console.log("Missing username or password!");
      res.status(500).send("Missing username or password!");
      return;
    }

    console.log(`[${username}] Starting`);

    //check if we have existing refresh token
    let user = await dbController.getUser(username);

    //temporarily disable token caching, sometimes pogo rejects a valid *old* token. TMS will always attempt to get a fresh token for now
    if (false && user && user.access_token && user.access_token_expire_timestamp > Utils.getUnixTime() + 300) {
      //return the last access_token if we have more than 5 minutes of use left
      let timeLeft = Math.floor((user.access_token_expire_timestamp - Utils.getUnixTime()) / 60);
      console.log(`[${username}] Returning existing access token with ${timeLeft} minutes left`);
      let access_token = user.access_token;
      res.json({
        access_token: access_token
      });
      return;
    }    
    else if (user && user.refresh_token && user.last_refreshed > Utils.getUnixTime() - 30 * 86400) {
      let result = await refreshToken(user);
      if (result && result.access_token) {
        console.log(`[${username}] Returning access token`);
        res.json({
          access_token: result.access_token
        });
        return;
      }
      else {
        res.status(500).send(`[${username}] Unabled to refresh token`);
        return;
      }
    }
    else {
      console.log(`[${username}] Getting login code`);
      let challenge = await pkceChallenge(86);

      let url = `https://access.pokemon.com/oauth2/auth?state=yWAw-S7ybrI4v4fG2RC_35Rg&scope=openid+offline+email+dob+pokemon_go+member_id+username&redirect_uri=https://www.pokemongolive.com/dl?app=pokemongo%26dl_action=OPEN_LOGIN&client_id=pokemon-go&response_type=code&code_challenge=${challenge.code_challenge}&code_challenge_method=S256`;

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
        console.log(`[${username}] PTC Auth error`);
        console.log(error);
      }

      if (body && body.data && body.data.login_code) {
        let login_code = body.data.login_code;
        console.log(`[${username}] Login code is ${login_code.substr(0,10)}....`);
        console.log(`[${username}] Exchanging for tokens`);

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
          body2 = await nAxios.post('https://access.pokemon.com/oauth2/token', querystring.stringify(tmpParams));

          let access_token = body2.data.access_token;
          let refresh_token = body2.data.refresh_token;
          let expire_timestamp = Utils.getUnixTime() + body2.data.expires_in;

          if (access_token) {

            if (refresh_token) {
              console.log(`[${username}] Saving refresh token`);
              await dbController.saveRefreshTokenForUser(username, refresh_token);
            }

            console.log(`[${username}] Saving access token`);
            await dbController.saveAccessTokenForUser(username, access_token, expire_timestamp);
            console.log(`[${username}] Returning access token`);
            res.json({
              access_token: access_token
            });
            return;
          }
          else {
            console.log(`[${username}] Unable to exchange tokens`);
          }
        }
        catch (error) {
          console.log(`[${username}] Exchaging token error`);
          console.log(error);
        }
      }
      else {
        console.log(`[${username}] Unable to get login code`);
      }
    }
    res.json({});
  });
  
  app.listen(appPort);
  console.log(`Listening on port ${appPort}`);

  //If enabled, try to refresh  30 tokens in 5 minutes interval. That's about a maximum of 8640 tokens per day. If you need more than that, reduce the interval and sleep time between requests. Please try to be sensible and do not flood PTC with requests.  
  if (config.get('refresh_token_keep_alive.enabled')) {
    setInterval(() => {
      keepAliveToken('refresh_token_keep_alive.tokens_per_interval')
    }, config.get('refresh_token_keep_alive.interval_seconds') * 1000);
  }
})();