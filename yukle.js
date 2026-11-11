'use strict';
const fs = require('fs');
const path = require('path');
const TOKEN = process.env.GH_TOKEN;
const OWNER = 'emrbsrurs2018-dot';
const REPO = 'golradar';
const H = { Authorization: 'token ' + TOKEN, 'User-Agent': 'golradar', Accept: 'application/vnd.github+json' };
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;

async function put(rel) {
  const body = {
    message: 'deploy ' + rel,
    content: fs.readFileSync(path.join(__dirname, rel)).toString('base64'),
  };
  const cur = await fetch(API + encodeURIComponent(rel).replace(/%2F/g, '/'), { headers: H });
  if (cur.status === 200) body.sha = (await cur.json()).sha;
  const r = await fetch(API + encodeURIComponent(rel).replace(/%2F/g, '/'), {
    method: 'PUT', headers: H, body: JSON.stringify(body),
  });
  console.log(rel, r.status);
  if (r.status >= 300) console.log((await r.text()).slice(0, 150));
}

(async () => {
  const dosyalar = [];
  const gez = (dir) => {
    for (const f of fs.readdirSync(path.join(__dirname, dir))) {
      const rel = dir ? dir + '/' + f : f;
      const st = fs.statSync(path.join(__dirname, rel));
      if (st.isDirectory()) gez(rel);
      else dosyalar.push(rel);
    }
  };
  gez('');
  for (const f of dosyalar) await put(f);
  console.log('bitti', dosyalar.length);
})();
