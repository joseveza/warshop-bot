require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.TOKEN;
const ID_TELEFONO = process.env.ID_TELEFONO;
const MONGO_URI = process.env.MONGO_URI;
const DOMINIO_PUBLICO = process.env.DOMINIO_PUBLICO || "https://warshop-bot.onrender.com";

// 1. CONEXIÓN A MONGODB
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Base de datos Warshop conectada'))
    .catch(err => console.error('❌ Error DB:', err));

// 2. MODELOS DE DATOS
const ConductorSchema = new mongoose.Schema({
    telefono: { type: String, unique: true },
    tipo: String, 
    nombre: String,
    cedula: String,
    // 🟢 NUEVO: Variables para controlar el cobro diario y saldo
    tipoVehiculo: { type: String, enum: ['Moto', 'Carro'], default: 'Carro' }, 
    saldo_prepago: { type: Number, default: 0 }, 
    ultima_fecha_cobro: { type: String, default: '' }, 
    
    vehiculo: { modelo: String, año: String, placa: String, color: String },
    linea: { nombre: String, rif: String },
    fotoCarro: String, 
    fase: { type: String, default: 'inicio' },
    status: { type: String, default: 'Provisional' },
    estadoTurno: { type: String, default: 'Inactivo', enum: ['Inactivo', 'Activo', 'Ocupado'] },
    ubicacion: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] }
    },
    createdAt: { type: Date, default: Date.now, index: { expires: '3d' } }
});
ConductorSchema.index({ ubicacion: "2dsphere" });
const Conductor = mongoose.model('Conductor', ConductorSchema);

const ViajeSchema = new mongoose.Schema({
    telefonoCliente: { type: String, unique: true },
    vehiculo: String,
    origen: String,
    coordenadasOrigen: { type: [Number] }, 
    destino: String,
    fase: { type: String, default: 'inicio' }, 
    conductorAsignado: { type: String }, 
    createdAt: { type: Date, default: Date.now, index: { expires: '1h' } } 
});
const Viaje = mongoose.model('Viaje', ViajeSchema);

// RUTAS DEL RADAR WEB
app.get('/tracker', (req, res) => { res.sendFile(path.join(__dirname, 'tracker.html')); });

app.post('/actualizar-gps', async (req, res) => {
    const { telefono, latitud, longitud } = req.body;
    try {
        await Conductor.findOneAndUpdate(
            { telefono: telefono },
            { ubicacion: { type: "Point", coordinates: [longitud, latitud] } }
        );
        res.sendStatus(200);
    } catch (error) { res.sendStatus(500); }
});

app.get('/', (req, res) => { res.send('🚀 WARSHOP MOBILITY operando.'); });

// WEBHOOK
app.get('/webhook', (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === "warshop2026") {
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
            let conductor = await Conductor.findOne({ telefono: telefonoCliente });
            let viaje = await Viaje.findOne({ telefonoCliente: telefonoCliente });

            // --- A. LÓGICA DE BOTONES ---
            if (message.type === "interactive") {
                const responseId = message.interactive.button_reply.id;

                if (responseId === "btn_afiliar") { await enviarMenuTipoConductor(telefonoCliente); } 
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
                else if (responseId === "select_moto" || responseId === "select_carro") {
                    const unidad = responseId === "select_moto" ? "Moto 🛵" : "Carro 🚗";
                    await Viaje.findOneAndUpdate(
                        { telefonoCliente: telefonoCliente },
                        { vehiculo: unidad, fase: 'pidiendo_origen' },
                        { upsert: true, new: true }
                    );
                    await enviarRespuesta(telefonoCliente, `Has elegido: *${unidad}*.\n\n📍 Para comenzar, envíanos tu *Ubicación Actual (Origen)* usando el clip 📎 o escribe tu dirección.`);
                }
                
                // 🟢 Lógica de Cobro Diario al Iniciar Turno
                else if (responseId === "btn_iniciar_turno") {
                    if (conductor) {
                        const opcionesFecha = { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' };
                        const fechaHoy = new Date().toLocaleDateString('es-VE', opcionesFecha); 
                        
                        if (conductor.ultima_fecha_cobro === fechaHoy) {
                            await Conductor.findOneAndUpdate({ telefono: telefonoCliente }, { estadoTurno: 'Activo' });
                            const urlTracker = `${DOMINIO_PUBLICO}/tracker?telefono=${telefonoCliente}`;
                            await enviarRespuesta(telefonoCliente, `¡De vuelta al ruedo! 🟢 Ya pagaste el uso de plataforma por hoy.\n\n⚠️ Mantén abierta esta pantalla para recibir viajes:\n${urlTracker}`);
                        } else {
                            const tarifa = conductor.tipoVehiculo === 'Moto' ? 2 : 3;
                            
                            if (conductor.saldo_prepago >= tarifa) {
                                conductor.saldo_prepago -= tarifa;
                                conductor.ultima_fecha_cobro = fechaHoy;
                                conductor.estadoTurno = 'Activo';
                                await conductor.save();
                                
                                const urlTracker = `${DOMINIO_PUBLICO}/tracker?telefono=${telefonoCliente}`;
                                await enviarRespuesta(telefonoCliente, `¡Jornada iniciada con éxito! 🟢\n💵 Se descontaron *$${tarifa}* de tu saldo (Restante: *$${conductor.saldo_prepago}*).\nRecuerda: El 100% de tus carreras de hoy son tuyas.\n\n⚠️ Mantén abierta esta pantalla:\n${urlTracker}`);
                            } else {
                                await enviarRespuesta(telefonoCliente, `❌ *Saldo Insuficiente*\n\nNecesitas *$${tarifa}* para operar hoy, pero tienes *$${conductor.saldo_prepago}*.\n\nPor favor recarga tu cuenta prepago para continuar.`);
                            }
                        }
                    }
                }
                else if (responseId === "btn_finalizar_turno") {
                    await Conductor.findOneAndUpdate({ telefono: telefonoCliente }, { estadoTurno: 'Inactivo' });
                    await enviarRespuesta(telefonoCliente, `Jornada finalizada 🔴.\n¡Buen descanso!`);
                }
                
                // 🟢 Lógica cuando el conductor ACEPTA o RECHAZA la alerta
                else if (responseId === "btn_aceptar_viaje") {
                    const viajePendiente = await Viaje.findOne({ conductorAsignado: telefonoCliente, fase: 'esperando_conductor' });
                    if (viajePendiente) {
                        await Conductor.findOneAndUpdate({ telefono: telefonoCliente }, { estadoTurno: 'Ocupado' });
                        
                        let enlaceNavegacion = viajePendiente.origen; 
                        if (viajePendiente.coordenadasOrigen && viajePendiente.coordenadasOrigen.length === 2) {
                            const lat = viajePendiente.coordenadasOrigen[1];
                            const lng = viajePendiente.coordenadasOrigen[0];
                            enlaceNavegacion = `https://maps.google.com/?q=${lat},${lng}`;
                        }

                        await enviarRespuesta(telefonoCliente, `✅ ¡Viaje Aceptado!\n\nToca el enlace para iniciar la ruta hacia el cliente:\n🗺️ ${enlaceNavegacion}\n\nDestino: ${viajePendiente.destino}`);
                        
                        viajePendiente.fase = 'en_curso';
                        await viajePendiente.save();
                        
                        const elConductor = await Conductor.findOne({ telefono: telefonoCliente });
                        const imagenFicha = elConductor.fotoCarro || "https://i.ibb.co/FkPGvQKx/fcha-lista-1.jpg";
                        
                        // 1. Envía la imagen de la ficha
                        await enviarImagen(viajePendiente.telefonoCliente, imagenFicha);
                        
                        // 🟢 NUEVO: Pausa de 2 segundos para asegurar que la imagen llegue primero
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // 2. Envía el texto con los datos
                        const textoFicha = `🚖 *TU CONDUCTOR ESTÁ EN CAMINO* 🚖\n\n👤 *Conductor:* ${elConductor.nombre}\n🚗 *Vehículo:* ${elConductor.vehiculo.modelo} (${elConductor.vehiculo.color})\n🔢 *Placa:* ${elConductor.vehiculo.placa}\n\n📍 Tu conductor ha aceptado el servicio y va en camino.`;
                        await enviarRespuesta(viajePendiente.telefonoCliente, textoFicha);
                    } else {
                        await enviarRespuesta(telefonoCliente, "⏳ Este viaje ya expiró o fue tomado por otro conductor.");
                    }
                }
                else if (responseId === "btn_rechazar_viaje") {
                    await enviarRespuesta(telefonoCliente, "❌ Viaje rechazado. Seguirás disponible para otros servicios.");
                    const viajePendiente = await Viaje.findOneAndUpdate(
                        { conductorAsignado: telefonoCliente, fase: 'esperando_conductor' },
                        { fase: 'finalizado', conductorAsignado: null } 
                    );
                    if (viajePendiente) {
                        await enviarRespuesta(viajePendiente.telefonoCliente, "Lo sentimos, el conductor más cercano no pudo tomar tu viaje. 😔 Intenta solicitarlo de nuevo.");
                    }
                }
            }
            // --- B. LÓGICA DE TEXTO ---
            else if (message.type === "text") {
                const texto = message.text.body;
                const textoLimpio = texto.toLowerCase().trim();

                // 🟢 COMANDO SECRETO DE RECARGA PARA EL ADMINISTRADOR
                if (textoLimpio.startsWith("ponte al dhia")) {
                    res.sendStatus(200); // 🔴 ESTA ES LA LÍNEA MÁGICA QUE DETIENE EL BUCLE
                    
                    const partes = textoLimpio.split(" ");
                    
                    if (partes.length === 5) {
                        const numeroConductor = partes[3];
                        const monto = parseFloat(partes[4]);
                        
                        let conductorRecarga = await Conductor.findOne({ telefono: numeroConductor });
                        
                        if (conductorRecarga) {
                            conductorRecarga.saldo_prepago += monto;
                            await conductorRecarga.save();
                            
                            await enviarRespuesta(telefonoCliente, `✅ *¡Recarga Exitosa!*\n\nSe sumaron *$${monto}* al conductor ${conductorRecarga.nombre} (${numeroConductor}).\nSaldo actual: *$${conductorRecarga.saldo_prepago}*`);
                            await enviarRespuesta(numeroConductor, `💰 *¡RECARGA RECIBIDA!* 💰\n\nSe han acreditado *$${monto}* a tu cuenta prepago de Warshop Mobility.\nTu saldo actual es de: *$${conductorRecarga.saldo_prepago}*.\n\n¡Gracias por tu excelente trabajo!`);
                        } else {
                            await enviarRespuesta(telefonoCliente, `❌ Error: No se encontró ningún conductor con el número ${numeroConductor}.\nRecuerda usar el código de país (ej: 58414...).`);
                        }
                    } else {
                        await enviarRespuesta(telefonoCliente, `⚠️ *Formato incorrecto.*\nUsa: ponte al dhia [numero] [monto]\nEjemplo: ponte al dhia 584141234567 5`);
                    }
                    return; 
                }

                if (textoLimpio === "turno" && conductor && conductor.fase === 'finalizado') {
                    await enviarMenuTurno(telefonoCliente);
                }
                else if (conductor && conductor.status === 'Provisional' && conductor.fase && conductor.fase !== 'finalizado' && conductor.fase !== 'inicio') {
                    switch (conductor.fase) {
                        case 'preguntar_nombre': conductor.nombre = texto; conductor.fase = 'preguntar_cedula'; break;
                        case 'preguntar_cedula': conductor.cedula = texto; conductor.fase = 'preguntar_tipo_vehiculo'; break;
                        case 'preguntar_tipo_vehiculo': 
                            conductor.tipoVehiculo = textoLimpio.includes('moto') ? 'Moto' : 'Carro';
                            conductor.fase = conductor.tipo === 'Independiente' ? 'preguntar_modelo' : 'preguntar_nombre_linea'; 
                            break;
                        case 'preguntar_modelo': conductor.vehiculo.modelo = texto; conductor.fase = 'preguntar_año'; break;
                        case 'preguntar_año': conductor.vehiculo.año = texto; conductor.fase = 'preguntar_placa'; break;
                        case 'preguntar_placa': conductor.vehiculo.placa = texto; conductor.fase = 'preguntar_color'; break;
                        case 'preguntar_color': conductor.vehiculo.color = texto; conductor.fase = 'finalizado'; break;
                        case 'preguntar_nombre_linea': conductor.linea.nombre = texto; conductor.fase = 'preguntar_rif'; break;
                        case 'preguntar_rif': conductor.linea.rif = texto; conductor.fase = 'finalizado'; break;
                    }
                    await conductor.save();
                    
                    if (conductor.fase === 'finalizado') {
                        await enviarRespuestaFinal(telefonoCliente, conductor.nombre);
                    } else {
                        const preguntas = { 
                            preguntar_cedula: "¿Cuál es tu número de *Cédula*?", 
                            preguntar_tipo_vehiculo: "🚕 ¿Qué vehículo conduces? Escribe *Moto* o *Carro*.",
                            preguntar_modelo: "¿Cuál es el *Modelo* del vehículo?", 
                            preguntar_nombre_linea: "¿Cómo se llama la *Línea*?", 
                            preguntar_año: "¿De qué *Año* es?", 
                            preguntar_placa: "¿Cuál es la *Placa*?", 
                            preguntar_color: "¿De qué *Color* es?", 
                            preguntar_rif: "¿Cuál es el *RIF* de la línea?" 
                        };
                        await enviarRespuesta(telefonoCliente, preguntas[conductor.fase]);
                    }
                } 
                else if (viaje && viaje.fase !== 'finalizado' && viaje.fase !== 'inicio') {
                    if (viaje.fase === 'pidiendo_origen') {
                        viaje.origen = texto; viaje.fase = 'pidiendo_destino'; await viaje.save();
                        await enviarRespuesta(telefonoCliente, "🎯 ¡Origen guardado! Ahora, ¿a dónde te diriges? Escribe tu *Destino* o envía la ubicación.");
                    } 
                    else if (viaje.fase === 'pidiendo_destino') {
                        viaje.destino = texto; viaje.fase = 'finalizado'; await viaje.save();
                        await procesarViaje(telefonoCliente, viaje);
                    }
                }
                else { await enviarMenuBienvenida(telefonoCliente); }
            }

            // --- C. LÓGICA DE UBICACIÓN ---
            else if (message.type === "location") {
                if (viaje && viaje.fase !== 'finalizado' && viaje.fase !== 'inicio') {
                    const lat = message.location.latitude;
                    const lng = message.location.longitude;
                    const ubicacionTexto = `Lat: ${lat}, Lng: ${lng}`;
                    
                    if (viaje.fase === 'pidiendo_origen') {
                        viaje.origen = ubicacionTexto; viaje.coordenadasOrigen = [lng, lat]; viaje.fase = 'pidiendo_destino'; await viaje.save();
                        await enviarRespuesta(telefonoCliente, "🎯 ¡Origen guardado! Ahora, ¿a dónde te diriges? Escribe tu *Destino* o envía la ubicación.");
                    } 
                    else if (viaje.fase === 'pidiendo_destino') {
                        viaje.destino = ubicacionTexto; viaje.fase = 'finalizado'; await viaje.save();
                        await procesarViaje(telefonoCliente, viaje);
                    }
                } else {
                    await enviarRespuesta(telefonoCliente, "📍 Ubicación recibida, pero no tienes un viaje activo. Escribe 'Hola' para ver el menú.");
                }
            }
        }
        res.sendStatus(200);
    } catch (error) { 
        console.error("❌ ERROR MOTOR:", error.message);
        res.sendStatus(500); 
    }
});

// --- FUNCIONES CENTRALES ---
async function procesarViaje(numeroCliente, viaje) {
    await enviarRespuesta(numeroCliente, "✅ Ruta confirmada.\n\n*Buscando al conductor más cercano...* 🔎📡");

    let conductorCercano = null;

    if (viaje.coordenadasOrigen && viaje.coordenadasOrigen.length === 2) {
        conductorCercano = await Conductor.findOne({
            fase: 'finalizado', 
            estadoTurno: 'Activo', 
            ubicacion: {
                $near: { $geometry: { type: "Point", coordinates: viaje.coordenadasOrigen }, $maxDistance: 8000 }
            }
        });
    }

    if (conductorCercano) {
        viaje.conductorAsignado = conductorCercano.telefono;
        viaje.fase = 'esperando_conductor';
        await viaje.save();
        await enviarAlertaConductor(conductorCercano.telefono, viaje);
    } else {
        await enviarRespuesta(numeroCliente, "Lo sentimos mucho. En este momento no hay conductores disponibles cerca de tu área. 😔 Intenta de nuevo en unos minutos.");
    }
}

async function enviarAlertaConductor(numeroConductor, viaje) {
    try {
        let textoOrigen = viaje.origen;
        
        if (viaje.coordenadasOrigen && viaje.coordenadasOrigen.length === 2) {
            const lat = viaje.coordenadasOrigen[1];
            const lng = viaje.coordenadasOrigen[0];
            const linkMapa = `https://maps.google.com/?q=${lat},${lng}`;
            textoOrigen = `📍 Ubicación GPS\n🗺️ Mapa: ${linkMapa}`;
        }

        await axios({
            method: "POST", url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp", to: numeroConductor, type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: `🚨 *¡NUEVO SERVICIO CERCANO!* 🚨\n\n*Origen:*\n${textoOrigen}\n\n🏁 *Destino:* ${viaje.destino}\n\n¿Deseas tomar este viaje?` },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "btn_aceptar_viaje", title: "✅ Aceptar Viaje" } },
                            { type: "reply", reply: { id: "btn_rechazar_viaje", title: "❌ Rechazar" } }
                        ]
                    }
                }
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) { console.error("❌ Error Alerta:", e.response?.data || e.message); }
}

async function enviarMenuTurno(numero) {
    try {
        await axios({
            method: "POST", url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`,
            data: {
                messaging_product: "whatsapp", to: numero, type: "interactive",
                interactive: {
                    type: "button", body: { text: "🚖 *Panel de Conductor*\n\n¿Qué deseas hacer con tu jornada laboral?" },
                    action: { buttons: [ { type: "reply", reply: { id: "btn_iniciar_turno", title: "🟢 Iniciar Jornada" } }, { type: "reply", reply: { id: "btn_finalizar_turno", title: "🔴 Finalizar Jornada" } } ] }
                }
            },
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        });
    } catch (e) {}
}

async function enviarRespuesta(numero, texto) {
    try { await axios({ method: "POST", url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, data: { messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } }, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } }); } catch (e) {}
}

async function enviarImagen(numero, urlImagen) {
    try { await axios({ method: "POST", url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, data: { messaging_product: "whatsapp", to: numero, type: "image", image: { link: urlImagen } }, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } }); } catch (e) {}
}

async function enviarMenuBienvenida(numero) {
    try { await axios({ method: "POST", url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, data: { messaging_product: "whatsapp", to: numero, type: "interactive", interactive: { type: "button", header: { type: "image", image: { link: "https://i.ibb.co/pBfkbfXx/mobility.png" } }, body: { text: "*¡Bienvenido a Warshop Mobility!* 🇻🇪\nTu plataforma de transporte confiable.\n¿Qué deseas hacer hoy?" }, action: { buttons: [ { type: "reply", reply: { id: "btn_solicitar", title: "Servicio Transporte" } }, { type: "reply", reply: { id: "btn_afiliar", title: "Afiliacion" } } ] } } }, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } }); } catch (e) {}
}

async function enviarMenuTipoConductor(numero) {
    try { await axios({ method: "POST", url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, data: { messaging_product: "whatsapp", to: numero, type: "interactive", interactive: { type: "button", body: { text: "Dinos qué tipo de conductor eres para iniciar:" }, action: { buttons: [ { type: "reply", reply: { id: "tipo_independiente", title: "Independiente" } }, { type: "reply", reply: { id: "tipo_linea", title: "De Línea" } } ] } } }, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } }); } catch (e) {}
}

async function enviarMenuVehiculos(numero) {
    try { await axios({ method: "POST", url: `https://graph.facebook.com/v21.0/${ID_TELEFONO}/messages`, data: { messaging_product: "whatsapp", to: numero, type: "interactive", interactive: { type: "button", body: { text: "¿En qué unidad viajas hoy?" }, action: { buttons: [ { type: "reply", reply: { id: "select_moto", title: "🛵 Moto" } }, { type: "reply", reply: { id: "select_carro", title: "🚗 Carro" } } ] } } }, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } }); } catch (e) {}
}

async function enviarRespuestaFinal(numero, nombre) {
    await enviarRespuesta(numero, `¡Todo listo, ${nombre}! ✅\n\nTu registro es *provisional*. Tienes *3 días hábiles* para ir a la oficina o se borrará automáticamente. ¡Te esperamos! 🚖`);
}

app.listen(PORT, () => { console.log(`🚀 Motor de WARSHOP rugiendo en puerto ${PORT}`); });