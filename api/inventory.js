// API privada del catálogo de Huella Universal.
// Lee la pestaña "Inventario" de Google Sheets desde el servidor.
// Las credenciales del robot NUNCA se envían al navegador.
//
// Variables de entorno requeridas en Vercel:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_KEY
//   GOOGLE_SHEET_ID

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getGoogleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!email || !rawKey) {
    throw new Error('Faltan GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel');
  }

  const privateKey = rawKey.replace(/\\n/g, '\n');
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();

  const signature = signer.sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = `${unsigned}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error('No se pudo autenticar con Google: ' + JSON.stringify(tokenData));
  }

  return tokenData.access_token;
}

async function getInventory(accessToken, sheetId) {
  const range = 'Inventario!A1:R2000';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('No se pudo leer la pestaña Inventario: ' + JSON.stringify(data));
  }

  return data.values || [];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      res.status(500).json({ error: 'Falta configurar GOOGLE_SHEET_ID en Vercel' });
      return;
    }

    const accessToken = await getGoogleAccessToken();
    const rows = await getInventory(accessToken, sheetId);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(200).json({ rows });
  } catch (err) {
    console.error('Error en /api/inventory:', err);
    res.status(500).json({ error: err.message || 'Error al cargar el inventario' });
  }
};
