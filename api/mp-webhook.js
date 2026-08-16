// Este webhook lo llama Mercado Pago automáticamente cada vez que el
// estado de un pago cambia (aprobado, rechazado, pendiente). Cuando el
// pago queda "approved", este código escribe una fila nueva en la
// pestaña "Ventas" de tu Google Sheets — así el stock se descuenta
// solo (la columna "stock" de Inventario ya está armada para restar
// automáticamente lo que aparezca en "Ventas").
//
// Requiere 3 variables de entorno en Vercel (además de MP_ACCESS_TOKEN
// que ya tienes configurada):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_KEY
//   GOOGLE_SHEET_ID
// Ver CONECTAR_VENTAS_INSTRUCCIONES.md para el paso a paso de cómo
// obtenerlas.

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

async function paymentAlreadyLogged(accessToken, sheetId, paymentId) {
  const range = 'Ventas!G:G';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return false;
  const data = await res.json();
  const rows = data.values || [];
  return rows.some((row) => (row[0] || '').includes(`Pago ID: ${paymentId}`));
}

async function appendVentaRows(accessToken, sheetId, rows) {
  const range = 'Ventas!A:G';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: rows }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('No se pudo escribir en Google Sheets: ' + JSON.stringify(data));
  }
  return data;
}

module.exports = async function handler(req, res) {
  // Mercado Pago espera una respuesta 200 rápida — respondemos primero
  // la validación y hacemos el trabajo, capturando cualquier error para
  // no dejar la notificación "colgada".
  try {
    const paymentId =
      (req.query && (req.query['data.id'] || req.query.id)) ||
      (req.body && req.body.data && req.body.data.id);

    const topic = (req.query && (req.query.topic || req.query.type)) || (req.body && req.body.type);

    if (!paymentId || (topic && topic !== 'payment')) {
      res.status(200).json({ received: true, skipped: true });
      return;
    }

    if (!process.env.MP_ACCESS_TOKEN) {
      console.error('Falta MP_ACCESS_TOKEN');
      res.status(200).json({ received: true, error: 'config' });
      return;
    }

    const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    const payment = await payRes.json();

    if (!payRes.ok || payment.status !== 'approved') {
      res.status(200).json({ received: true, status: payment.status || 'unknown' });
      return;
    }

    const items = (payment.additional_info && payment.additional_info.items) || [];
    if (!items.length) {
      res.status(200).json({ received: true, warning: 'sin items' });
      return;
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      console.error('Falta GOOGLE_SHEET_ID');
      res.status(200).json({ received: true, error: 'config' });
      return;
    }

    const accessToken = await getGoogleAccessToken();

    const alreadyLogged = await paymentAlreadyLogged(accessToken, sheetId, paymentId);
    if (alreadyLogged) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    const meta = payment.metadata || {};
    const clienteInfo = meta.cliente_nombre
      ? `Cliente: ${meta.cliente_nombre} | CC: ${meta.cliente_cedula || '—'} | Tel: ${meta.cliente_telefono || '—'} | ${meta.cliente_ciudad || '—'}, ${meta.cliente_direccion || '—'} | Correo: ${meta.cliente_correo || '—'}`
      : 'Sin datos de cliente';

    const today = new Date().toISOString().slice(0, 10);
    const rows = items.map((it) => {
      const qty = parseInt(it.quantity, 10) || 0;
      const price = parseFloat(it.unit_price) || 0;
      return [
        today,
        it.id || it.title || 'SIN-SKU',
        qty,
        price,
        qty * price,
        'Web',
        `${clienteInfo} | Pago ID: ${paymentId}`,
      ];
    });

    await appendVentaRows(accessToken, sheetId, rows);

    res.status(200).json({ received: true, logged: rows.length });
  } catch (err) {
    console.error('Error en mp-webhook:', err);
    // Igual respondemos 200 para que Mercado Pago no reintente en bucle;
    // el error queda en los logs de Vercel para revisarlo.
    res.status(200).json({ received: true, error: String(err.message || err) });
  }
};
