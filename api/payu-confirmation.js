// PayU llama esta URL automáticamente (servidor a servidor) cuando un
// pago con PayU cambia de estado. Verificamos la firma para confirmar
// que el aviso realmente viene de PayU, y si el pago quedó aprobado
// (state_pol = 4), registramos la venta en la pestaña "Ventas" —
// igual que el webhook de Mercado Pago.

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
  if (!tokenRes.ok) throw new Error('No se pudo autenticar con Google: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function paymentAlreadyLogged(accessToken, sheetId, referenceCode) {
  const range = 'Ventas!G:G';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return false;
  const data = await res.json();
  const rows = data.values || [];
  return rows.some((row) => (row[0] || '').includes(`PayU Ref: ${referenceCode}`));
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

// Formatea el valor exactamente como lo exige PayU para la firma de confirmación
function formatValueForSignature(value) {
  const num = parseFloat(value);
  const rounded = Math.round(num * 100) / 100;
  const secondDecimal = Math.round((rounded * 100)) % 10;
  return secondDecimal === 0 ? rounded.toFixed(1) : rounded.toFixed(2);
}

module.exports = async function handler(req, res) {
  // PayU espera una respuesta 200 simple (sin HTML) — siempre respondemos
  // 200 aunque algo falle internamente, para que no reintente en bucle.
  try {
    const body = req.body || {};
    const {
      merchant_id, reference_sale, value, currency, state_pol, sign,
      transaction_id, extra1,
    } = body;

    if (!merchant_id || !reference_sale || !sign) {
      res.status(200).send('OK');
      return;
    }

    if (!process.env.PAYU_API_KEY) {
      console.error('Falta PAYU_API_KEY');
      res.status(200).send('OK');
      return;
    }

    const formattedValue = formatValueForSignature(value);
    const expectedSignature = crypto
      .createHash('md5')
      .update(`${process.env.PAYU_API_KEY}~${merchant_id}~${reference_sale}~${formattedValue}~${currency}~${state_pol}`)
      .digest('hex');

    if (expectedSignature.toLowerCase() !== String(sign).toLowerCase()) {
      console.error('Firma de PayU inválida — posible notificación falsa', { reference_sale });
      res.status(200).send('OK');
      return;
    }

    // state_pol: 4 = Aprobada, 6 = Rechazada, 5 = Expirada, 7 = Pendiente
    if (String(state_pol) !== '4') {
      res.status(200).send('OK');
      return;
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      console.error('Falta GOOGLE_SHEET_ID');
      res.status(200).send('OK');
      return;
    }

    const accessToken = await getGoogleAccessToken();

    const alreadyLogged = await paymentAlreadyLogged(accessToken, sheetId, reference_sale);
    if (alreadyLogged) {
      res.status(200).send('OK');
      return;
    }

    // El "extra1" trae el detalle sku:cantidad:precio de cada producto,
    // separado por "|" — lo mandamos nosotros mismos al crear el formulario.
    const today = new Date().toISOString().slice(0, 10);
    const detailStr = extra1 || '';
    const itemRows = detailStr
      .split('|')
      .map((part) => part.split(':'))
      .filter((parts) => parts.length === 3)
      .map(([sku, cantidad, precio]) => {
        const qty = parseInt(cantidad, 10) || 1;
        const price = parseFloat(precio) || 0;
        return [today, sku, qty, price, qty * price, 'Web', `PayU Ref: ${reference_sale} | Transacción: ${transaction_id || ''}`];
      });

    // Respaldo por si extra1 llegara vacío (no debería pasar en circunstancias
    // normales): registramos igual el total para no perder la venta, aunque
    // sin desglose de stock por producto.
    const rows = itemRows.length ? itemRows : [[
      today, 'SIN-SKU-PAYU', 1, parseFloat(value) || 0, parseFloat(value) || 0,
      'Web', `PayU Ref: ${reference_sale} | Transacción: ${transaction_id || ''} | (sin detalle de productos)`,
    ]];

    for (const row of rows) {
      await appendVentaRow(accessToken, sheetId, row);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error en payu-confirmation:', err);
    res.status(200).send('OK');
  }
};
