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
                
                // 🟢 NUEVO: Lógica de Cobro Diario al Iniciar Turno
                else if (responseId === "btn_iniciar_turno") {
                    if (conductor) {
                        // Obtenemos la fecha exacta en Venezuela para el reinicio diario
                        const opcionesFecha = { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' };
                        const fechaHoy = new Date().toLocaleDateString('es-VE', opcionesFecha); 
                        
                        // Validamos si ya pagó hoy
                        if (conductor.ultima_fecha_cobro === fechaHoy) {
                            await Conductor.findOneAndUpdate({ telefono: telefonoCliente }, { estadoTurno: 'Activo' });
                            const urlTracker = `${DOMINIO_PUBLICO}/tracker?telefono=${telefonoCliente}`;
                            await enviarRespuesta(telefonoCliente, `¡De vuelta al ruedo! 🟢 Ya pagaste el uso de plataforma por hoy.\n\n⚠️ Mantén abierta esta pantalla para recibir viajes:\n${urlTracker}`);
                        } else {
                            // Es un día nuevo, validamos saldo
                            const tarifa = conductor.tipoVehiculo === 'Moto' ? 2 : 3;
                            
                            if (conductor.saldo_prepago >= tarifa) {
                                // Cobro exitoso
                                conductor.saldo_prepago -= tarifa;
                                conductor.ultima_fecha_cobro = fechaHoy;
                                conductor.estadoTurno = 'Activo';
                                await conductor.save();
                                
                                const urlTracker = `${DOMINIO_PUBLICO}/tracker?telefono=${telefonoCliente}`;
                                await enviarRespuesta(telefonoCliente, `¡Jornada iniciada con éxito! 🟢\n💵 Se descontaron *$${tarifa}* de tu saldo (Restante: *$${conductor.saldo_prepago}*).\nRecuerda: El 100% de tus carreras de hoy son tuyas.\n\n⚠️ Mantén abierta esta pantalla:\n${urlTracker}`);
                            } else {
                                // Saldo insuficiente (No se le cambia el estado a Activo)
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
                        const imagenFicha = elConductor.fotoCarro || "https://i.ibb.co/pBfkbfXx/mobility.png";
                        await enviarImagen(viajePendiente.telefonoCliente, imagenFicha);
                        
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

                // 🟢 NUEVO: COMANDO SECRETO DE RECARGA PARA EL ADMINISTRADOR
                if (textoLimpio.startsWith("ponte al dhia")) {
                    const partes = textoLimpio.split(" ");
                    
                    if (partes.length === 5) {
                        const numeroConductor = partes[3];
                        const monto = parseFloat(partes[4]);
                        
                        let conductorRecarga = await Conductor.findOne({ telefono: numeroConductor });
                        
                        if (conductorRecarga) {
                            conductorRecarga.saldo_prepago += monto;
                            await conductorRecarga.save();
                            
                            // Confirmación para ti (Administrador)
                            await enviarRespuesta(telefonoCliente, `✅ *¡Recarga Exitosa!*\n\nSe sumaron *$${monto}* al conductor ${conductorRecarga.nombre} (${numeroConductor}).\nSaldo actual: *$${conductorRecarga.saldo_prepago}*`);
                            
                            // Notificación automática para el conductor
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
                else if (conductor && conductor.status === 'Provisional' && conductor.fase && conductor