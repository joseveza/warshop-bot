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

app.get('/', (req, res) => {
    res.send('🚀 El motor de WARSHOP MOBILITY está rugiendo.');
});

// 3. VERIFICACIÓN DEL WEBHOOK
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "warshop2026";
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
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
            let conductor = await Conductor.findOne({ telefono: telefonoCliente });

            // --- A. LÓGICA DE BOTONES (INTERACTIVOS) ---
            if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;
                console.log(`🔘 Botón presionado: ${responseId}`); // Esto te ayudará a ver qué llega en Render

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
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${tipo}*.\n\n📝 ¿Cuál es tu *Nombre y Apellido*?`);
                }
                else if (responseId === "btn_solicitar") {
                    await enviarMenuVehiculos(telefonoCliente);
                }
                // --- AQUÍ ESTABA EL ERROR: Faltaban estas líneas ---
                else if (responseId === "select_moto" || responseId === "select_carro") {
                    const unidad = responseId === "select_moto" ? "Moto 🛵" : "Carro 🚗";
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${unidad}*.\n\n📍 Ahora, envíanos tu *Ubicación Actual* por WhatsApp para buscarte la unidad más cercana.`);
                }
            }

            // --- B. LÓGICA DE TEXTO (REGISTRO) ---
            else if (message.type === "text") {
                const texto = message.text.body;

                if (conductor && conductor.status === 'Provisional' && conductor.fase && conductor.fase !== 'finalizado' && conductor.fase !== 'inicio') {
                    switch (conductor.fase) {
                        case 'preguntar_nombre':
                            conductor.nombre = texto; conductor.fase = 'preguntar_cedula';
                            break;
                        case 'preguntar_cedula':
                            conductor.cedula = texto;
                            conductor.fase = conductor.tipo === 'Independiente' ? 'preguntar_modelo' : 'preguntar_nombre_linea';
                            break;
                        case 'preguntar_modelo':
                            conductor.vehiculo.modelo = texto; conductor.fase = 'preguntar_año';
                            break;
                        case 'preguntar_año':
                            conductor.vehiculo.año = texto; conductor.fase = 'preguntar_placa';
                            break;
                        case 'preguntar_placa':
                            conductor.vehiculo.placa = texto; conductor.fase = 'preguntar_color';
                            break;
                        case 'preguntar_color':
                            conductor.vehiculo.color = texto; conductor.fase = 'finalizado';
                            break;
                        case 'preguntar_nombre_linea':
                            conductor.linea.nombre = texto; conductor.fase = 'preguntar_rif';
                            break;
                        case 'preguntar_rif':
                            conductor.linea.rif = texto; conductor.fase = 'finalizado';
                            break;
                    }
                    await conductor.save();
                    
                    if (conductor.fase === 'finalizado') {
                        await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                    } else {
                        const preguntas = {
                            preguntar_cedula: "¿Cuál es tu número de *Cédula*?",
                            preguntar_modelo: "¿Cuál es el *Modelo* del vehículo?",
                            preguntar_nombre_linea: "¿Cómo se llama la *Línea*?",
                            preguntar_año: "¿De qué *Año* es?",
                            preguntar_placa: "¿Cuál es la *Placa*?",
                            preguntar_color: "¿De qué *Color*?",
                            preguntar_rif: "¿Cuál es el *RIF* de la línea?"
                        };
                        await enviarRespuesta(telefonoCliente, preguntas[conductor.fase]);
                    }
                } 
                else {
                    await enviarMenuBienvenida(telefonoCliente);
                }
            }

            // --- C. LÓGICA DE UBICACIÓN ---
            else if (message.type === "location") {
                await enviarRespuesta(telefonoCliente, "¡Ubicación recibida! ✅ Estamos buscando tu unidad de *Warshop*. Te avisaremos en un momento.");
            }
        }
        res.sendStatus(200);
    } catch (error) { 
        console.error("❌ ERROR MOTOR:", error.message);
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
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("❌ Error Texto:", e.response?.data || e.message); }
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
                    header: { 
                        type: "image", 
                        image: { link: "https://i.ibb.co/pBfkbfXx/mobility.png" } 
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
    } catch (e) { console.error("❌ Error Bienvenida:", e.response?.data || e.message); }
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
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("❌ Error Tipo:", e.response?.data || e.message); }
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
    } catch (e) { console.error("❌ Error Vehículos:", e.response?.data || e.message); }
}

async function enviarRespuestaFinal(numero, nombre) {
    const texto = `¡Todo listo, ${nombre}! ✅\n\nTu registro es *provisional*. Tienes *3 días hábiles* para ir a la oficina o se borrará automáticamente. ¡Te esperamos! 🚖`;
    await enviarRespuesta(numero, texto);
}

app.listen(PORT, () => { console.log(`🚀 Motor de WARSHOP rugiendo en puerto ${PORT}`); });