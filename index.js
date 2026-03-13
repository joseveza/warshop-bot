require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.TOKEN;
const ID_TELEFONO = process.env.ID_TELEFONO;

app.get('/', (req, res) => {
    res.send('¡El servidor de WARSHOP está activo y listo para responder! 🚖');
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

// 3. RECIBIR MENSAJES Y RESPONDER CON EL MENÚ PROFESIONAL
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (message) {
            const telefonoCliente = message.from;

            // CASO A: El cliente escribe un texto (Hola, Buenos días, etc.)
            if (message.type === "text") {
                console.log(`📩 Cliente escribió: ${message.text.body}`);
                await enviarMenuBienvenida(telefonoCliente);
            } 

            // CASO B: El cliente toca uno de los botones del menú
            else if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;
                console.log(`🔘 Botón presionado: ${responseId}`);

                if (responseId === "btn_solicitar") {
                    await enviarRespuesta(telefonoCliente, "¡Excelente! 🚖 Por favor, envíanos tu ubicación para asignarte la unidad más cercana.");
                } else if (responseId === "btn_afiliar") {
                    await enviarRespuesta(telefonoCliente, "¡Bienvenido al equipo! 🔑 ¿Deseas afiliar un *Vehículo* o una *Moto*?");
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error:", error);
        res.sendStatus(500);
    }
});

// FUNCIÓN PARA EL MENÚ VISUAL CON BOTONES
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
                        image: {
                            // ⚠️ REEMPLAZA "TU_ID_AQUI" con el ID de tu imagen en Google Drive
                            link: "https://drive.google.com/uc?export=view&id=1FteftVfZTXRtHsWFl-azEwhgtYSefhOE"
                        }
                    },
                    body: {
                        text: "*¡Bienvenido a Warshop Mobility!* 🇻🇪\n\nTu plataforma de transporte confiable.\n\n¿Qué deseas hacer hoy?"
                    },
                    footer: {
                        text: "Selecciona una opción abajo 👇"
                    },
                    action: {
                        buttons: [
                            {
                                type: "reply",
                                reply: { id: "btn_solicitar", title: "🚖 Solicitar Servicio" }
                            },
                            {
                                type: "reply",
                                reply: { id: "btn_afiliar", title: "🔑 Afiliación" }
                            }
                        ]
                    }
                }
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
        console.log("✅ Menú de Bienvenida enviado");
    } catch (error) {
        console.error("❌ Error enviando menú:", error.response?.data || error.message);
    }
}

// FUNCIÓN PARA TEXTO SIMPLE (La usamos para las respuestas de los botones)
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
    } catch (error) {
        console.error("❌ Error al enviar texto:", error.response?.data || error.message);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Motor de WARSHOP rugiendo en el puerto ${PORT}`);
});

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
                        image: {
                            // 👉 AQUÍ PEGAS TU LINK DE GOOGLE DRIVE (EL QUE CONVERTIMOS)
                            link: "https://drive.google.com/uc?export=view&id=174zehhNwqJg6yYKqxmOkpewoIhdsMytr"
                        }
                    },
                    body: {
                        text: "*¡Bienvenido a Warshop Mobility!* 🇻🇪\nTu plataforma de transporte confiable.\n¿Qué deseas hacer hoy?"
                    },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "btn_solicitar", title: "Solicitar Servicio" } },
                            { type: "reply", reply: { id: "btn_afiliar", title: "Afiliación" } }
                        ]
                    }
                }
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (error) {
        console.error("❌ Error enviando menú:", error.response?.data || error.message);
    }
}
