const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Si es una request de listFiles
    if (url.searchParams.get('action') === 'listFiles') {
      const folderId = url.searchParams.get('folderId');

      if (!folderId) {
        return new Response(JSON.stringify({ error: 'Missing folderId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      try {
        const privateKey = env.SA_PRIVATE_KEY.replace(/\\n/g, '\n');
        const accessToken = await getGoogleAccessToken(env.SA_CLIENT_EMAIL, privateKey);

        const type = url.searchParams.get('type') || 'image';
        const mimeFilter = type === 'video' ? `mimeType contains 'video'` : `mimeType contains 'image'`;
        const searchQuery = `parents='${folderId}' and ${mimeFilter}`;
        const driveUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQuery)}&spaces=drive&fields=files(id,name,webContentLink)`;

        const res = await fetch(driveUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(`Drive API error: ${data.error?.message || res.status}`);
        }

        return new Response(JSON.stringify({ files: data.files || [] }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    const code = url.searchParams.get('code');

    if (!code) {
      return new Response(JSON.stringify({ error: 'Missing code' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const SHEET_ID = '1wODkzWQ3FOmOJcyXU9p3G_H3NwzCdqzvG1zAOW58Kj8';
    const SHEET_NAME = 'Kapturit-Portal';

    try {
      console.log('[sheets] SA_CLIENT_EMAIL:', env.SA_CLIENT_EMAIL ?? 'UNDEFINED');
      console.log('[sheets] SA_PRIVATE_KEY present:', !!env.SA_PRIVATE_KEY);
      console.log('[sheets] SA_PRIVATE_KEY starts with:', env.SA_PRIVATE_KEY?.slice(0, 30));

      const privateKey = env.SA_PRIVATE_KEY.replace(/\\n/g, '\n');
      console.log('[sheets] privateKey after replace, first line:', privateKey.split('\n')[0]);

      const accessToken = await getGoogleAccessToken(env.SA_CLIENT_EMAIL, privateKey);
      console.log('[sheets] accessToken obtained, length:', accessToken?.length);

      const range = encodeURIComponent(`${SHEET_NAME}!A:T`);
      const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
      console.log('[sheets] requesting:', sheetsUrl);

      const res = await fetch(sheetsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      console.log('[sheets] response status:', res.status);

      if (!res.ok) {
        const errText = await res.text();
        console.log('[sheets] error body:', errText);
        throw new Error(`Sheets API error ${res.status}: ${errText}`);
      }

      const json = await res.json();
      const rows = json.values || [];

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if ((r[18] || '').toUpperCase() === code.toUpperCase()) {
          return new Response(
            JSON.stringify({
              ID: r[0] || '',
              baby_name: r[1] || '',
              last_name: r[2] || '',
              session_date: r[3] || '',
              session_type: r[4] || 'Session',
              hospital: r[5] || '',
              weight: r[6] || '—',
              height: r[7] || '—',
              paid: r[8] || 'no',
              stripe_link: r[9] || '',
              drive_preview_folder: r[10] || '',
              drive_hd_folder: r[11] || '',
              gallery_printlab_link: r[12] || '',
              name_package: r[13] || '',
              price_package: r[14] || '',
              drive_preview_folder_id: r[15] || '',
              drive_hd_folder_id: r[16] || '',
              video_folder_id: r[19] || '',
            }),
            { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      return new Response(JSON.stringify({ error: 'Code not found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function getGoogleAccessToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const b64url = (obj) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const keyData = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const jwt = `${signingInput}.${encodedSig}`;

  console.log('[oauth] requesting token for:', clientEmail);
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  console.log('[oauth] token response status:', tokenRes.status);
  const tokenJson = await tokenRes.json();
  console.log('[oauth] token response body:', JSON.stringify(tokenJson));

  if (!tokenJson.access_token) {
    throw new Error(`OAuth error: ${JSON.stringify(tokenJson)}`);
  }
  return tokenJson.access_token;
}
