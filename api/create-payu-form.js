// Arma el pago de PayU para el carrito completo (no por producto).
// El detalle exacto de qué se compró (sku, cantidad, precio) se manda
// codificado en el campo "extra1" del formulario — PayU nos lo devuelve
// intacto en la confirmación (api/payu-confirmation.js), así no hace
// falta guardar nada en Sheets antes de que el cliente pague.
//
// Requiere estas variables de entorno además de las de Google Sheets:
//   PAYU_API_KEY, PAYU_MERCHANT_ID, PAYU_ACCOUNT_ID
//   PAYU_TEST = "1" mientras pruebas, quítala (o ponla en "0") cuando
//   estés list@ para cobros reales.
// Ver CONECTAR_VENTAS_INSTRUCCIONES.md para dónde conseguir estos datos.

const crypto = require('crypto');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// PayU pide el valor formateado con 1 decimal si el segundo decimal es
// cero (ej. 119000 -> "119000.0"), o con 2 decimales si tiene centavos.
function formatAmountForSignature(amount) {
  const n = Math.round(amount * 100) / 100;
  const cents = Math.round((n - Math.floor(n)) * 100);
  return cents === 0 ? n.toFixed(1) : n.toFixed(2);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const { items, customer } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'El carrito está vacío' });
      return;
    }
    if (!customer || !customer.nombre || !customer.cedula || !customer.ciudad ||
        !customer.direccion || !customer.correo) {
      res.status(400).json({ error: 'Faltan datos del cliente' });
      return;
    }

    const cleanItems = items.map((it) => {
      const quantity = parseInt(it.quantity, 10);
      const unit_price = Math.round(parseFloat(it.unit_price));
      if (!it.id || !it.title || !quantity || quantity <= 0 || !unit_price || unit_price <= 0) {
        throw new Error('Producto inválido en el carrito');
      }
      return { sku: String(it.id), title: String(it.title).slice(0, 200), quantity, unit_price };
    });

    const totalAmount = Math.round(
      cleanItems.reduce((sum, it) => sum + it.quantity * it.unit_price, 0)
    );

    const { PAYU_API_KEY, PAYU_MERCHANT_ID, PAYU_ACCOUNT_ID, PAYU_TEST } = process.env;

    if (!PAYU_API_KEY || !PAYU_MERCHANT_ID || !PAYU_ACCOUNT_ID) {
      res.status(500).json({ error: 'Faltan las variables de PayU en el servidor (PAYU_API_KEY, PAYU_MERCHANT_ID, PAYU_ACCOUNT_ID)' });
      return;
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const referenceCode = `HU-${Date.now()}`;
    const currency = 'COP';
    const amountStr = formatAmountForSignature(totalAmount);
    const isTest = PAYU_TEST === '1';

    const signature = md5(`${PAYU_API_KEY}~${PAYU_MERCHANT_ID}~${referenceCode}~${amountStr}~${currency}`);

    // IVA del 19% incluido en el precio (estándar Colombia) — PayU pide
    // que taxReturnBase + tax sumen exactamente el total.
    const taxReturnBase = Math.round(totalAmount / 1.19);
    const tax = totalAmount - taxReturnBase;

    // Detalle compacto: sku:cantidad:precio|sku:cantidad:precio...
    const extra1 = cleanItems.map((it) => `${it.sku}:${it.quantity}:${it.unit_price}`).join('|');
    if (extra1.length > 250) {
      res.status(400).json({ error: 'El carrito tiene demasiados productos distintos para procesar de una vez. Divide la compra en dos pedidos.' });
      return;
    }

    const description = `Huella Universal - ${cleanItems.length} producto(s)`;

    res.status(200).json({
      actionUrl: isTest
        ? 'https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/'
        : 'https://checkout.payulatam.com/ppp-web-gateway-payu/',
      fields: {
        merchantId: PAYU_MERCHANT_ID,
        accountId: PAYU_ACCOUNT_ID,
        description,
        referenceCode,
        amount: amountStr,
        tax: String(tax),
        taxReturnBase: String(taxReturnBase),
        currency,
        signature,
        test: isTest ? '1' : '0',
        buyerEmail: customer.correo,
        buyerFullName: customer.nombre,
        telephone: customer.telefono || '',
        responseUrl: `${origin}/payu-respuesta.html`,
        confirmationUrl: `${origin}/api/payu-confirmation`,
        extra1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Error al crear el pago con PayU' });
  }
};
