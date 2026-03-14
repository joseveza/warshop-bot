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

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Conectado a la base de datos de Warshop'))
    .catch(err => console.error('❌ Error de conexión:', err));

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

app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "warshop2026";
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
});

app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (message) {
            const telefonoCliente = message.from;
            console.log(`📩 Mensaje recibido de ${telefonoCliente}`);

            let conductor = await Conductor.findOne({ telefono: telefonoCliente });

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
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${tipo}*.\n\n📝 ¿Cuál es tu *Nombre y Apellido*?`);
                }
                else if (responseId === "btn_solicitar") { await enviarMenuVehiculos(telefonoCliente); }
            }
            else if (message.type === "text") {
                const texto = message.text.body;
                if (conductor && conductor.status === 'Provisional' && conductor.fase !== 'finalizado') {
                    // Lógica de registro paso a paso... (Se mantiene igual que la tenías)
                    switch (conductor.fase) {
                        case 'preguntar_nombre':
                            conductor.nombre = texto; conductor.fase = 'preguntar_cedula';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿Tu número de *Cédula*?");
                            break;
                        case 'preguntar_cedula':
                            conductor.cedula = texto;
                            conductor.fase = conductor.tipo === 'Independiente' ? 'preguntar_modelo' : 'preguntar_nombre_linea';
                            await conductor.save();
                            await enviarRespuesta(telefonoCliente, conductor.tipo === 'Independiente' ? "¿Modelo del vehículo?" : "¿Nombre de la Línea?");
                            break;
                        case 'preguntar_modelo':
                            conductor.vehiculo.modelo = texto; conductor.fase = 'preguntar_año';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿Año?");
                            break;
                        case 'preguntar_año':
                            conductor.vehiculo.año = texto; conductor.fase = 'preguntar_placa';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿Placa?");
                            break;
                        case 'preguntar_placa':
                            conductor.vehiculo.placa = texto; conductor.fase = 'preguntar_color';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿Color?");
                            break;
                        case 'preguntar_color':
                            conductor.vehiculo.color = texto; conductor.fase = 'finalizado';
                            await conductor.save(); await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                            break;
                        case 'preguntar_nombre_linea':
                            conductor.linea.nombre = texto; conductor.fase = 'preguntar_rif';
                            await conductor.save(); await enviarRespuesta(telefonoCliente, "¿RIF?");
                            break;
                        case 'preguntar_rif':
                            conductor.linea.rif = texto; conductor.fase = 'finalizado';
                            await conductor.save(); await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                            break;
                    }
                } else {
                    await enviarMenuBienvenida(telefonoCliente);
                }
            }
        }
        res.sendStatus(200);
    } catch (error) { console.error("❌ Error motor:", error); res.sendStatus(500); }
});

// --- FUNCIONES DE ENVÍO CORREGIDAS ---

async function enviarRespuesta(numero, texto) {
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, 
        { messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } },
        { headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } });
    } catch (e) { console.error("❌ Error enviarRespuesta:", e.response?.data || e.message); }
}

async function enviarMenuBienvenida(numero) {
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, {
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
        }, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } });
    } catch (e) { console.error("❌ Error MenuBienvenida:", e.response?.data || e.message); }
}

async function enviarMenuTipoConductor(numero) {
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, {
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
        }, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } });
    } catch (e) { console.error("❌ Error TipoConductor:", e.response?.data || e.message); }
}

async function enviarRespuestaFinal(numero, nombre) {
    await enviarRespuesta(numero, `¡Todo listo, ${nombre}! ✅\n\nTu registro es *provisional*. Tienes *3 días hábiles* para ir a la oficina o se borrará.`);
}

app.listen(PORT, () => { console.log(`🚀 Warshop rugiendo en puerto ${PORT}`); });