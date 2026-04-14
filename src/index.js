const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const RATE_MAX    = 10;
const RATE_WINDOW = 3600; // 1 hour

async function checkRateLimit(env, ip) {
  const raw  = await env.RATE_LIMIT.get(`rl:${ip}`);
  const data = raw ? JSON.parse(raw) : { count: 0 };
  return data.count < RATE_MAX;
}

async function recordFailedAttempt(env, ip) {
  const key  = `rl:${ip}`;
  const raw  = await env.RATE_LIMIT.get(key);
  const data = raw ? JSON.parse(raw) : { count: 0 };
  data.count += 1;
  await env.RATE_LIMIT.put(key, JSON.stringify(data), { expirationTtl: RATE_WINDOW });
}

async function clearRateLimit(env, ip) {
  await env.RATE_LIMIT.delete(`rl:${ip}`);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ── List files from a Google Drive folder ──
    if (url.searchParams.get('action') === 'listFiles') {
      const raw      = url.searchParams.get('folderId') || '';
      const match    = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      const folderId = match ? match[1] : raw.trim();
      if (!folderId) {
        return new Response(JSON.stringify({ error: 'Missing folderId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      try {
        const token     = await getGoogleAccessToken(env);
        const type      = url.searchParams.get('type') || 'image';
        const mime      = type === 'video' ? `mimeType contains 'video'` : `mimeType contains 'image'`;
        const driveUrl  = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`parents='${folderId}' and ${mime}`)}&spaces=drive&fields=files(id,name,webContentLink)&orderBy=name`;
        const res       = await fetch(driveUrl, { headers: { Authorization: `Bearer ${token}` } });
        const data      = await res.json();
        if (!res.ok) throw new Error(`Drive API error: ${data.error?.message || res.status}`);
        return new Response(JSON.stringify({ files: data.files || [] }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // ── Client lookup by token ──
    const code = url.searchParams.get('code');
    if (!code) {
      return new Response(JSON.stringify({ error: 'Missing code' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await checkRateLimit(env, ip);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Too many attempts. Try again in 1 hour.' }), {
        status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const SHEET_ID   = '1_VJRENBGuwD1R2GEQAjgpsz9ca3-h4n6ID3uPETGkQQ';
    const SHEET_NAME = 'Clients';

    // Extract Drive folder ID from full URL or return as-is if already an ID
    const extractFolderId = (val) => {
      if (!val) return '';
      const m = val.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      return m ? m[1] : val.trim();
    };

    try {
      const accessToken = await getGoogleAccessToken(env);
      const range       = encodeURIComponent(`${SHEET_NAME}!A:L`);
      const sheetsUrl   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
      const res         = await fetch(sheetsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Sheets API error ${res.status}: ${err}`);
      }

      const { values: rows = [] } = await res.json();

      // columns: A=token B=first_name C=last_name D=baby_name E=hospital
      //          F=session_date G=delivery_type H=photo_folder_id
      //          I=video_folder_id J=pixieset_id K=status
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if ((r[0] || '').toUpperCase() !== code.toUpperCase()) continue;

        const status = (r[10] || 'active').toLowerCase();
        if (status === 'expired') {
          return new Response(JSON.stringify({ error: 'Link expired' }), {
            status: 410, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        await clearRateLimit(env, ip);

        const pixieset_id = r[9] || '';
        return new Response(
          JSON.stringify({
            first_name:      r[1]  || '',
            last_name:       r[2]  || '',
            baby_name:       r[3]  || '',
            hospital:        r[4]  || '',
            session_date:    r[5]  || '',
            delivery_type:   r[6]  || 'photos',        // photos | video | photos_video | photos_print | photos_video_print
            photo_folder_id: extractFolderId(r[7]),
            video_folder_id: extractFolderId(r[8]),
            pixieset_url:    pixieset_id ? `https://heartproductions.pixieset.com/${pixieset_id}/` : '',
            prints_message:  r[11] || '',
          }),
          { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      await recordFailedAttempt(env, ip);
      return new Response(JSON.stringify({ error: 'Code not found' }), {
        status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function getGoogleAccessToken(env) {
  const now        = Math.floor(Date.now() / 1000);
  const privateKey = env.SA_PRIVATE_KEY.replace(/\\n/g, '\n');

  const b64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss:   env.SA_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })}`;

  const keyData   = privateKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(keyData), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;

  const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const { access_token, error } = await tokenRes.json();
  if (!access_token) throw new Error(`OAuth error: ${JSON.stringify(error)}`);
  return access_token;
}
