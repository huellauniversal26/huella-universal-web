// Recibe el SKU escaneado desde escanear.html, busca el producto en la
// pestaña "Inventario", y agrega la venta en "Ventas" — igual que el
// webhook de Mercado Pago, pero para ventas en tienda física.
//
// Usa las mismas 3 variables de entorno que ya configuraste para las
// ventas automáticas (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY,
// GOOGLE_SHEET_ID), más una nueva: PIN_VENTAS (un código simple que solo
// conocen el dueño y el trabajador, para que nadie más pueda registrar
// ventas si encuentra el link de esta página).

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
    throw new Error('Faltan GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY');
  }
  const privateKey = rawKey.replace(/\\n/g, '\n');

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey)
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

async function getInventarioRows(accessToken, sheetId) {
  const range = 'Inventario!A2:R2000';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error('No se pudo leer Inventario: ' + JSON.stringify(data));
  return data.values || [];
}

async function appendVentaRow(accessToken, sheetId, row) {
  const range = 'Ventas!A:G';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('No se pudo escribir en Ventas: ' + JSON.stringify(data));
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const { sku, cantidad, pin } = req.body || {};

    if (!process.env.PIN_VENTAS) {
      res.status(500).json({ error: 'Falta configurar PIN_VENTAS en el servidor' });
      return;
    }
    if (!pin || String(pin) !== String(process.env.PIN_VENTAS)) {
      res.status(401).json({ error: 'PIN incorrecto' });
      return;
    }

    const skuLimpio = String(sku || '').trim();
    const qty = parseInt(cantidad, 10) || 1;
    if (!skuLimpio) {
      res.status(400).json({ error: 'Falta el código escaneado' });
      return;
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      res.status(500).json({ error: 'Falta configurar GOOGLE_SHEET_ID en el servidor' });
      return;
    }

    const accessToken = await getGoogleAccessToken();
    const rows = await getInventarioRows(accessToken, sheetId);

    // Columnas de Inventario (0-indexado): A=0 nombre ... I=8 sku, K=10 stock, L=11 precio_detal
    const match = rows.find((r) => (r[8] || '').trim() === skuLimpio);

    if (!match) {
      res.status(404).json({ error: `No se encontró el SKU "${skuLimpio}" en el inventario` });
      return;
    }

    const nombre = match[0] || 'Producto';
    const color = match[5] || '';
    const talla = match[7] || '';
    const stockActual = parseInt(match[10], 10) || 0;
    const precio = parseFloat(match[11]) || 0;

    const today = new Date().toISOString().slice(0, 10);
    await appendVentaRow(accessToken, sheetId, [
      today,
      skuLimpio,
      qty,
      precio,
      qty * precio,
      'Tienda física',
      'Registrado por escáner de código de barras',
    ]);

    res.status(200).json({
      ok: true,
      nombre,
      color,
      talla,
      precio,
      cantidad: qty,
      stock_antes: stockActual,
      stock_bajo: stockActual - qty <= 0,
    });
  } catch (err) {
    console.error('Error en registrar-venta:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};
