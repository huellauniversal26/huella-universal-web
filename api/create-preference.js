// Esta función corre en el servidor (nunca en el navegador del cliente),
// así que la clave secreta de Mercado Pago (MP_ACCESS_TOKEN) nunca queda
// expuesta. Se configura como variable de entorno en Vercel — ver
// DEPLOY_INSTRUCCIONES.md.

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

    // Validación básica de cada producto
    const mpItems = items.map((it) => {
      const quantity = parseInt(it.quantity, 10);
      const unit_price = parseFloat(it.unit_price);
      if (!it.title || !quantity || quantity <= 0 || !unit_price || unit_price <= 0) {
        throw new Error('Producto inválido en el carrito');
      }
      return {
        id: it.id ? String(it.id).slice(0, 100) : undefined,
        title: String(it.title).slice(0, 250),
        quantity,
        unit_price,
        currency_id: 'COP',
      };
    });

    if (!process.env.MP_ACCESS_TOKEN) {
      res.status(500).json({ error: 'Falta configurar MP_ACCESS_TOKEN en el servidor' });
      return;
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    // Separar nombre y apellido lo mejor posible para el checkout de MP
    const nameParts = String(customer.nombre).trim().split(/\s+/);
    const firstName = nameParts.shift() || '';
    const lastName = nameParts.join(' ') || firstName;

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: mpItems,
        payer: {
          name: firstName,
          surname: lastName,
          email: customer.correo,
          phone: { number: String(customer.telefono || '') },
          identification: { type: 'CC', number: String(customer.cedula) },
          address: { street_name: customer.direccion },
        },
        back_urls: {
          success: `${origin}/exito.html`,
          failure: `${origin}/pago-fallido.html`,
          pending: `${origin}/pago-pendiente.html`,
        },
        auto_return: 'approved',
        statement_descriptor: 'HUELLA UNIVERSAL',
        notification_url: `${origin}/api/mp-webhook`,
        metadata: {
          cliente_nombre: customer.nombre,
          cliente_cedula: customer.cedula,
          cliente_ciudad: customer.ciudad,
          cliente_direccion: customer.direccion,
          cliente_telefono: customer.telefono,
          cliente_correo: customer.correo,
        },
      }),
    });

    const data = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error('Error de Mercado Pago:', data);
      res.status(502).json({ error: 'Mercado Pago rechazó la solicitud', detail: data });
      return;
    }

    res.status(200).json({ init_point: data.init_point });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Error al crear el pago' });
  }
};
