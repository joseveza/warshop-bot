require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// CONFIGURACIÓN DE TUS LLAVES (Sacadas de tu archivo .env)
const TOKEN = process.env.TOKEN;
const ID_TELEFONO = process.env.ID_TELEFONO;

// 1. RUTA DE PRUEBA
app.get('/', (req, res) => {
    res.send('¡El servidor de WARSHOP está activo y listo para responder! 🚖');
});

// 2. VERIFICACIÓN DEL WEBHOOK (El saludo con Meta)
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "warshop2026";
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 3. RECIBIR MENSAJES Y RESPONDER AUTOMÁTICAMENTE
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (message) {
            const telefonoCliente = message.from; // Número de quien te escribió
            const textoRecibido = message.text?.body; // Lo que te escribió
            
            console.log(`📩 Mensaje de ${telefonoCliente}: "${textoRecibido}"`);

            // --- AQUÍ EL BOT RESPONDE ---
            await enviarRespuesta(telefonoCliente, `¡Hola! Soy el asistente de *WARSHOP*. Recibí tu mensaje: "${textoRecibido}". En breve un humano te atenderá. 🚖⚙️`);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error procesando el mensaje:", error);
        res.sendStatus(500);
    }
});

// FUNCIÓN PARA ENVIAR MENSAJES
async function enviarRespuesta(numero, texto) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp",
                to: numero,
                type: "text",
                text: { body: texto },
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
        console.log("✅ Respuesta enviada con éxito");
    } catch (error) {
        console.error("❌ Error al enviar respuesta:", error.response?.data || error.message);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Motor de WARSHOP rugiendo en el puerto ${PORT}`);
});