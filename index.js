require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.TOKEN;
const ID_TELEFONO = process.env.ID_TELEFONO;

app.get('/', (req, res) => {
    res.send('¡El motor de WARSHOP está encendido! 🚖');
});

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

app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (message) {
            const telefonoCliente = message.from;

            // 1. SI RECIBIMOS TEXTO (BIENVENIDA)
            if (message.type === "text") {
                await enviarMenuBienvenida(telefonoCliente);
            } 

            // 2. SI TOCAN UN BOTÓN INTERACTIVO
            else if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;

                if (responseId === "btn_solicitar") {
                    await enviarMenuVehiculos(telefonoCliente);
                } 
                else if (responseId === "btn_afiliar") {
                    await enviarRespuesta(telefonoCliente, "¡Bienvenido al equipo! 🔑 Por favor, envíanos tu *Nombre completo* y una foto de tu *Cédula* para iniciar el registro.");
                }
                else if (responseId === "select_moto" || responseId === "select_carro") {
                    const tipo = responseId === "select_moto" ? "Moto 🛵" : "Carro 🚗";
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${tipo}*.\n\n📍 Ahora, por favor, envíanos tu *Ubicación Actual*:\n\n1. Toca el clip (📎) o el signo (+).\n2. Elige "Ubicación".\n3. Selecciona "Ubicación en tiempo real" o "Enviar mi ubicación actual".`);
                }
            }

            // 3. SI EL CLIENTE ENVÍA SU UBICACIÓN GPS 📍
            else if (message.type === "location") {
                const lat = message.location.latitude;
                const lng = message.location.longitude;
                
                console.log(`📍 Coordenadas de ${telefonoCliente}: Lat ${lat}, Lng ${lng}`);
                
                // Aquí el bot confirma y tú podrías recibir esta info en un grupo de conductores
                await enviarRespuesta(telefonoCliente, "¡Ubicación recibida con éxito! ✅📍 Estamos buscando la unidad de *Warshop Mobility* más cercana a tu posición. Te avisaremos en un momento.");
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error en el motor:", error);
        res.sendStatus(500);
    }
});

// --- FUNCIONES DE ENVÍO ---

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