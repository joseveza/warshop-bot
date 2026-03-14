require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');

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

// 2. MODELO DE DATOS
const ConductorSchema = new mongoose.Schema({
    telefono: { type: String, unique: true },
    tipo: String,
    nombre: String,
    cedula: String,
    vehiculo: { modelo: String, año: String, placa: String, color: String },
    linea: { nombre: String, rif: String },
    fase: { type: String, default: 'inicio' },
    status: { type: String, default: 'Provisional' },
    createdAt: { type: Date, default: Date.now, index: { expires: '3d' } }
});

const Conductor = mongoose.model('Conductor', ConductorSchema);

// 3. WEBHOOK (VERIFICACIÓN)
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

// 4. RECEPCIÓN DE MENSAJES
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (message) {
            const telefonoCliente = message.from;
            console.log(`📩 Mensaje recibido de ${telefonoCliente}: ${message.type}`);

            let conductor = await Conductor.findOne({ telefono: telefonoCliente });

            // --- A. MANEJO DE BOTONES ---
            if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;

                if (responseId === "btn_afiliar") {
                    await enviarMenuTipoConductor(telefonoCliente);
                } 
                else if (responseId === "tipo_independiente" || responseId === "tipo_linea") {
                    const tipo = responseId === "tipo_independiente" ? "Independiente" : "De Línea";
                    await Conductor.findOneAndUpdate(
                        { telefono: telefonoCliente },
                        { tipo: tipo, fase: 'preguntar_nombre', status: 'Provisional' },
                        { upsert: true, new: true }
                    );
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${tipo}*.\n\nComencemos el registro. 📝 ¿Cuál es tu *Nombre y Apellido*?`);
                }
                else if (responseId === "btn_solicitar") {
                    await enviarMenuVehiculos(telefonoCliente);
                }
                else if (responseId === "select_moto" || responseId === "select_carro") {
                    const vehiculo = responseId === "select_moto" ? "Moto 🛵" : "Carro 🚗";
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${vehiculo}*.\n\n📍 Ahora, envíanos tu *Ubicación Actual* para buscarte la unidad.`);
                }
            }

            // --- B. MANEJO DE TEXTO ---
            else if (message.type === "text") {
                const texto = message.text.body;

                // SI ESTÁ EN REGISTRO PROVISIONAL
                if (conductor && conductor.status === 'Provisional' && conductor.fase !== 'finalizado') {
                    switch (conductor.fase) {
                        case 'preguntar_nombre':
                            conductor.nombre = texto; conductor.fase = 'preguntar_cedula';
                            await conductor.save();
                            await enviarRespuesta(telefonoCliente, "Perfecto. ¿Cuál es tu número de *Cédula*?");
                            break;
                        case 'preguntar_cedula':
                            conductor.cedula = texto;
                            conductor.fase = conductor.tipo === 'Independiente' ? 'preguntar_modelo' : 'preguntar_nombre_linea';
                            await conductor.save();
                            await enviarRespuesta(telefonoCliente, conductor.tipo === 'Independiente' ? "¿Modelo de vehículo?" : "¿Nombre de la Línea?");
                            break;
                        case 'preguntar_modelo':
                            conductor.vehiculo.modelo = texto; conductor.fase = 'preguntar_año';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿De qué *Año* es?");
                            break;
                        case 'preguntar_año':
                            conductor.vehiculo.año = texto; conductor.fase = 'preguntar_placa';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿Número de *Placa*?");
                            break;
                        case 'preguntar_placa':
                            conductor.vehiculo.placa = texto; conductor.fase = 'preguntar_color';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿De qué *Color*?");
                            break;
                        case 'preguntar_color':
                            conductor.vehiculo.color = texto; conductor.fase = 'finalizado';
                            await conductor.save(); await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                            break;
                        case 'preguntar_nombre_linea':
                            conductor.linea.nombre = texto; conductor.fase = 'preguntar_rif';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿Cuál es el *RIF*?");
                            break;
                        case 'preguntar_rif':
                            conductor.linea.rif = texto; conductor.fase = 'finalizado';
                            await conductor.save(); await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                            break;
                    }
                } 
                // SI NO ESTÁ EN REGISTRO O YA TERMINÓ, SIEMPRE MENÚ DE BIENVENIDA
                else {
                    await enviarMenuBienvenida(telefonoCliente);
                }
            }

            // --- C. MANEJO DE UBICACIÓN ---
            else if (message.type === "location") {
                await enviarRespuesta(telefonoCliente, "¡Ubicación recibida! ✅ Estamos buscando tu unidad de *Warshop*.");
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error en el motor:", error);
        res.sendStatus(500);
    }
});

// --- FUNCIONES DE ENVÍO ---

async function enviarRespuesta(numero, texto) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: { messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } },
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("Error envío:", e.response?.data); }
}

async function enviarMenuBienvenida(numero) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp", to: numero, type: "interactive",
                interactive: {
                    type: "button",
                    header: { type: "image", image: { link: "https://drive.google.com/uc?export=view&id=174zehhNwqJg6yYKqxmOkpewoIhdsMytr" } },
                    body: { text: "*¡Bienvenido a Warshop Mobility!* 🇻🇪\n¿Qué deseas hacer hoy?" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "btn_solicitar", title: "Servicio Transporte" } },
                            { type: "reply", reply: { id: "btn_afiliar", title: "Afiliacion" } }
                        ]
                    }
                }
            },
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("Error Bienvenida:", e.response?.data); }
}

async function enviarMenuTipoConductor(numero) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp", to: numero, type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: "Dinos qué tipo de conductor eres:" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "tipo_independiente", title: "Independiente" } },
                            { type: "reply", reply: { id: "tipo_linea", title: "De Línea" } }
                        ]
                    }
                }
            },
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("Error Tipo:", e.response?.data); }
}

async function enviarMenuVehiculos(numero) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp", to: numero, type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: "¿En qué unidad viajas hoy?" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "select_moto", title: "🛵 Moto" } },
                            { type: "reply", reply: { id: "select_carro", title: "🚗 Carro" } }
                        ]
                    }
                }
            },
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("Error Vehículos:", e.response?.data); }
}

async function enviarRespuestaFinal(numero, nombre) {
    const textoFinal = `¡Todo listo, ${nombre}! ✅\n\nTu registro es *provisional*. Tienes *3 días hábiles* para ir a la oficina o se borrará. ¡Te esperamos! 🚖`;
    await enviarRespuesta(numero, textoFinal);
}

app.listen(PORT, () => { console.log(`🚀 Motor rugiendo en puerto ${PORT}`); });