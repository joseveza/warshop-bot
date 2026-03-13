require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.TOKEN;
const ID_TELEFONO = process.env.ID_TELEFONO;

// 1. RUTA DE PRUEBA
app.get('/', (req, res) => {
    res.send('¡El servidor de WARSHOP está activo! 🚖');
});

// 2. VERIFICACIÓN DEL WEBHOOK
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

// 3. RECIBIR MENSAJES Y PROCESAR ACCIONES
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (message) {
            const telefonoCliente = message.from;

            // --- SI EL CLIENTE ESCRIBE TEXTO ---
            if (message.type === "text") {
                await enviarMenuBienvenida(telefonoCliente);
            } 

            // --- SI EL CLIENTE TOCA UN BOTÓN ---
            else if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;

                // Si tocó "Servicio Transporte"
                if (responseId === "btn_solicitar") {
                    await enviarMenuVehiculos(telefonoCliente);
                } 
                // Si tocó "Afiliación"
                else if (responseId === "btn_afiliar") {
                    await enviarRespuesta(telefonoCliente, "¡Bienvenido! 🔑 ¿Deseas afiliar un *Vehículo* o una *Moto*? Envíanos tu nombre completo para iniciar.");
                }
                // Si seleccionó el tipo de vehículo
                else if (responseId === "select_moto" || responseId === "select_carro") {
                    const tipo = responseId === "select_moto" ? "Moto 🛵" : "Carro 🚗";
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${tipo}*.\n\nAhora, por favor, envíanos tu *Ubicación* (usando el clip de WhatsApp 📎) para buscarte la unidad más cercana.`);
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error:", error);
        res.sendStatus(500);
    }
});

// --- FUNCIONES AUXILIARES (Van al final) ---

async function enviarMenuBienvenida(numero) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp",
                to: numero,
                type: "interactive",
                interactive: {
                    type: "button",
                    header: {
                        type: "image",
                        image: { link: "https://drive.google.com/uc?export=view&id=174zehhNwqJg6yYKqxmOkpewoIhdsMytr" }
                    },
                    body: { text: "*¡Bienvenido a Warshop Mobility!* 🇻🇪\nTu plataforma de transporte confiable.\n¿Qué deseas hacer hoy?" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "btn_solicitar", title: "Servicio Transporte" } },
                            { type: "reply", reply: { id: "btn_afiliar", title: "Afiliacion" } }
                        ]
                    }
                }
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (error) { console.error("Error Bienvenida:", error.response?.data); }
}

async function enviarMenuVehiculos(numero) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp",
                to: numero,
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: "¡Excelente! 🚖 ¿En qué tipo de unidad prefieres viajar hoy?" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "select_moto", title: "🛵 Moto" } },
                            { type: "reply", reply: { id: "select_carro", title: "🚗 Carro" } }
                        ]
                    }
                }
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (error) { console.error("Error Vehículos:", error.response?.data); }
}

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
    } catch (error) { console.error("Error Texto:", error.response?.data); }
}

app.listen(PORT, () => {
    console.log(`🚀 Motor de WARSHOP rugiendo en el puerto ${PORT}`);
});