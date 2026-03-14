require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose'); // <-- Nueva herramienta de base de datos

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// VARIABLES DE ENTORNO
const TOKEN = process.env.TOKEN;
const ID_TELEFONO = process.env.ID_TELEFONO;
const MONGO_URI = process.env.MONGO_URI;

// 1. CONEXIÓN A MONGODB
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Conectado a la base de datos de Warshop'))
    .catch(err => console.error('❌ Error de conexión a MongoDB:', err));

// 2. MODELO DE DATOS (La "ficha" del conductor)
const ConductorSchema = new mongoose.Schema({
    telefono: String,
    datos: String, // Aquí guardaremos el nombre y la cédula que envíen
    fecha: { type: Date, default: Date.now }
});
const Conductor = mongoose.model('Conductor', ConductorSchema);

app.get('/', (req, res) => {
    res.send('¡El motor de WARSHOP está encendido y con memoria! 🚖');
});

// VERIFICACIÓN DEL WEBHOOK
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

// RECOPCIÓN DE MENSAJES
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (message) {
            const telefonoCliente = message.from;

            // --- LÓGICA DE TEXTO (BIENVENIDA O REGISTRO) ---
            if (message.type === "text") {
                const textoUser = message.text.body.toLowerCase();

                // Si el mensaje parece un registro (contiene nombre o cedula)
                if (textoUser.includes("nombre") || textoUser.includes("cedula")) {
                    const nuevoConductor = new Conductor({
                        telefono: telefonoCliente,
                        datos: message.text.body
                    });
                    await nuevoConductor.save(); // <-- AQUÍ SE GUARDA EN LA NUBE
                    await enviarRespuesta(telefonoCliente, "✅ *¡Warshop Mobility te ha registrado!* Tus datos han sido guardados con éxito en nuestra base de datos.");
                } else {
                    await enviarMenuBienvenida(telefonoCliente);
                }
            } 

            // --- LÓGICA DE BOTONES ---
            else if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;

                if (responseId === "btn_solicitar") {
                    await enviarMenuVehiculos(telefonoCliente);
                } 
                else if (responseId === "btn_afiliar") {
                    await enviarRespuesta(telefonoCliente, "¡Bienvenido al equipo! 🔑 Por favor, envíanos tu *Nombre completo* y tu *Cédula* en un solo mensaje para iniciar el registro.");
                }
                else if (responseId === "select_moto" || responseId === "select_carro") {
                    const tipo = responseId === "select_moto" ? "Moto 🛵" : "Carro 🚗";
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${tipo}*.\n\n📍 Ahora, envíanos tu *Ubicación Actual* por WhatsApp para buscarte la unidad más cercana.`);
                }
            }

            // --- LÓGICA DE UBICACIÓN ---
            else if (message.type === "location") {
                const lat = message.location.latitude;
                const lng = message.location.longitude;
                console.log(`📍 Coordenadas de ${telefonoCliente}: Lat ${lat}, Lng ${lng}`);
                await enviarRespuesta(telefonoCliente, "¡Ubicación recibida! ✅ Estamos buscando tu unidad de *Warshop*. Te avisaremos en un momento.");
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