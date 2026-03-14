require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.TOKEN;
const ID_TELEFONO = process.env.ID_TELEFONO;
const MONGO_URI = process.env.MONGO_URI;

// 1. CONEXIÓN A MONGODB
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Base de datos Warshop conectada'))
    .catch(err => console.error('❌ Error DB:', err));

// 2. MODELO DE DATOS DETALLADO
const ConductorSchema = new mongoose.Schema({
    telefono: { type: String, unique: true },
    tipo: String, // 'Independiente' o 'De Línea'
    nombre: String,
    cedula: String,
    vehiculo: { modelo: String, año: String, placa: String, color: String },
    linea: { nombre: String, rif: String },
    fase: { type: String, default: 'inicio' },
    status: { type: String, default: 'Provisional' },
    createdAt: { type: Date, default: Date.now, index: { expires: '3d' } }
});
const Conductor = mongoose.model('Conductor', ConductorSchema);

// VERIFICACIÓN DEL WEBHOOK
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "warshop2026";
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
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
            let conductor = await Conductor.findOne({ telefono: telefonoCliente });

            // --- A. LÓGICA DE BOTONES ---
            if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;

                if (responseId === "btn_afiliar") {
                    await enviarMenuTipoConductor(telefonoCliente);
                } 
                else if (responseId === "tipo_independiente" || responseId === "tipo_linea") {
                    const tipo = responseId === "tipo_independiente" ? "Independiente" : "De Línea";
                    // Resetear o crear conductor con el tipo elegido
                    await Conductor.findOneAndUpdate(
                        { telefono: telefonoCliente },
                        { tipo: tipo, fase: 'preguntar_nombre', status: 'Provisional' },
                        { upsert: true, new: true }
                    );
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${tipo}*.\n\n📝 ¿Cuál es tu *Nombre y Apellido*?`);
                }
                else if (responseId === "btn_solicitar") { await enviarMenuVehiculos(telefonoCliente); }
                else if (responseId === "select_moto" || responseId === "select_carro") {
                    await enviarRespuesta(telefonoCliente, "📍 Por favor, envíanos tu *Ubicación Actual*.");
                }
            }

            // --- B. LÓGICA DE TEXTO (FLUJO PASO A PASO) ---
            else if (message.type === "text") {
                const texto = message.text.body;

                // Si es un conductor registrándose
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
                            await enviarRespuesta(telefonoCliente, conductor.tipo === 'Independiente' ? "¿Cuál es el *Modelo* del vehículo?" : "¿Cómo se llama tu *Línea*?");
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
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿De qué *Color* es?");
                            break;
                        case 'preguntar_color':
                            conductor.vehiculo.color = texto; conductor.fase = 'finalizado';
                            await conductor.save(); await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                            break;
                        case 'preguntar_nombre_linea':
                            conductor.linea.nombre = texto; conductor.fase = 'preguntar_rif';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿Cuál es el *RIF* de la línea?");
                            break;
                        case 'preguntar_rif':
                            conductor.linea.rif = texto; conductor.fase = 'finalizado';
                            await conductor.save(); await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                            break;
                    }
                } else {
                    // Si no está en registro, mandamos bienvenida
                    await enviarMenuBienvenida(telefonoCliente);
                }
            }

            // --- C. LÓGICA DE UBICACIÓN ---
            else if (message.type === "location") {
                await enviarRespuesta(telefonoCliente, "¡Ubicación recibida! ✅ Estamos buscando tu unidad de *Warshop*.");
            }
        }
        res.sendStatus(200);
    } catch (error) { console.error("❌ Error motor:", error); res.sendStatus(500); }
});

// --- FUNCIONES DE ENVÍO (TU ESTILO FUNCIONAL) ---

async function enviarRespuesta(numero, texto) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: { messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("Error Texto:", e.response?.data); }
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
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
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
                    body: { text: "Dinos qué tipo de conductor eres para iniciar:" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "tipo_independiente", title: "Independiente" } },
                            { type: "reply", reply: { id: "tipo_linea", title: "De Línea" } }
                        ]
                    }
                }
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
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
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("Error Vehículos:", e.response?.data); }
}

async function enviarRespuestaFinal(numero, nombre) {
    const texto = `¡Todo listo, ${nombre}! ✅\n\nTu registro ha sido recibido de forma *provisional*.\n\n📍 Tienes *3 días hábiles* para venir a la oficina a formalizar y tomar las fotos, o el registro se borrará. ¡Te esperamos! 🚖`;
    await enviarRespuesta(numero, texto);
}

app.listen(PORT, () => { console.log(`🚀 Motor de WARSHOP rugiendo en el puerto ${PORT}`); });