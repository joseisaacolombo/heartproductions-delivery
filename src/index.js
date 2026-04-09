const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Package catalog (update prices/links when Stripe links are ready) ──
const PACKAGES = [
  {
    id: 'photos',
    name: 'Digital Visual Legacy',
    badge: null,
    description: 'Still cinematography focused — a comprehensive collection of professionally mastered digital highlights.',
    features: ['40+ Mastered Highlights', 'Digital Art Gallery Access', 'Private Viewing & Download Rights', 'Secure SMS Delivery'],
    prices: { hospital: 149, portal: 199, regular: 249 },
    stripe: { hospital: '#', portal: '#', regular: '#' }, // replace with real Stripe links
  },
  {
    id: 'video',
    name: 'Cinematic Heirloom',
    badge: 'Most Popular',
    description: 'Motion tells the story still filmmaking cannot — a professionally edited film capturing the rhythm and sound of your baby\'s arrival.',
    features: ['Full HD Cinematic Heirloom Film', 'Director\'s Cut Highlight Reel', 'Instant SMS Arrival Alert', 'Raw Narrative Audio Capture', 'Private Secure Portal'],
    prices: { hospital: 249, portal: 329, regular: 399 },
    stripe: { hospital: '#', portal: '#', regular: '#' },
  },
  {
    id: 'bundle',
    name: 'The Masterpiece Collection',
    badge: null,
    description: 'The ultimate preservation — full scale cinematography, film, and a physical heirloom book to be touched for generations.',
    features: ['Full Cinematography Suite', 'Hand-Bound Linen Heirloom Album', 'SMS Alerts & Premium Private Portal', 'Priority Filmmaker Assignment'],
    prices: { hospital: 449, portal: 549, regular: 649 },
    stripe: { hospital: '#', portal: '#', regular: '#' },
  },
];

function getPriceTier(sentAt) {
  if (!sentAt) return 'regular';
  const sent = new Date(sentAt).getTime();
  if (isNaN(sent)) return 'regular';
  const hoursElapsed = (Date.now() - sent) / 3600000;
  if (hoursElapsed < 0) return 'hospital'; // sent in the future = hospital session
  if (hoursElapsed <= 72) return 'portal';
  return 'regular';
}

const RATE_MAX      = 10;   // max failed attempts
const RATE_WINDOW   = 3600; // seconds (1 hour)

async function checkRateLimit(env, ip) {
  const key  = `rl:${ip}`;
  const raw  = await env.RATE_LIMIT.get(key);
  const data = raw ? JSON.parse(raw) : { count: 0 };

  if (data.count >= RATE_MAX) return false; // blocked
  return true; // allowed
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

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await checkRateLimit(env, ip);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Too many attempts. Try again in 1 hour.' }), {
        status: 429,
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

      const range = encodeURIComponent(`${SHEET_NAME}!A:V`);
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
          await clearRateLimit(env, ip); // reset counter on success
          const sentAt   = r[21] || ''; // Column V: sent_at
          const tier     = getPriceTier(sentAt);
          const packages = PACKAGES.map(pkg => ({
            id:          pkg.id,
            name:        pkg.name,
            badge:       pkg.badge,
            description: pkg.description,
            features:    pkg.features,
            price:       pkg.prices[tier],
            price_regular: pkg.prices.regular,
            stripe_link: pkg.stripe[tier],
            tier,
          }));
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
              drive_preview_folder: r[10] || '',
              drive_hd_folder: r[11] || '',
              drive_preview_folder_id: r[15] || '',
              drive_hd_folder_id: r[16] || '',
              video_folder_id: r[19] || '',
              sent_at: sentAt,
              price_tier: tier,
              packages,
            }),
            { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      await recordFailedAttempt(env, ip); // count failed lookup
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
