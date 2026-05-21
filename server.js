/*
 * ============================================================
 * HF-006 MQTT ↔ WebSocket Bridge
 * Deploy: Render.com (Node.js Web Service)
 * 
 * Função: Recebe dados MQTT do ESP32 e os retransmite
 *         via WebSocket para o portal Bubble.io
 * ============================================================
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const mqtt       = require('mqtt');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ============================================================
// VARIÁVEIS DE AMBIENTE (configurar no Render Dashboard)
// ============================================================
const PORT            = process.env.PORT       || 3000;
const MQTT_BROKER_URL = process.env.MQTT_URL   || 'mqtts://YOUR_HIVEMQ_HOST:8883';
const MQTT_USERNAME   = process.env.MQTT_USER  || '';
const MQTT_PASSWORD   = process.env.MQTT_PASS  || '';
const WS_SECRET       = process.env.WS_SECRET  || 'changeme_secret';

// Tópico wildcard — captura todos os dispositivos
const MQTT_TOPIC_STATUS = 'hf006/+/status';
const MQTT_TOPIC_CMD    = 'hf006/{id}/cmd';

// ============================================================
// ESTADO EM MEMÓRIA (últimos status por placa)
// ============================================================
const deviceStatus = {}; // { [deviceId]: { ...statusPayload, lastSeen: Date } }

// ============================================================
// MQTT CLIENT
// ============================================================
const mqttOptions = {
  username:          MQTT_USERNAME,
  password:          MQTT_PASSWORD,
  protocol: 'mqtts',
  port: 8883,
  rejectUnauthorized: false,
  reconnectPeriod:   5000,
  keepalive:         60,
};

const mqttClient = mqtt.connect(MQTT_BROKER_URL, mqttOptions);

mqttClient.on('connect', () => {
  console.log('[MQTT] Conectado ao broker:', MQTT_BROKER_URL);
  mqttClient.subscribe(MQTT_TOPIC_STATUS, { qos: 1 }, (err) => {
    if (err) console.error('[MQTT] Erro ao subscrever:', err);
    else console.log('[MQTT] Subscrito em:', MQTT_TOPIC_STATUS);
  });
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Erro:', err.message);
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] Reconectando...');
});

mqttClient.on('message', (topic, payload) => {
  try {
    // Extrair device ID do tópico: hf006/{id}/status
    const parts = topic.split('/');
    const deviceId = parts[1];
    const data = JSON.parse(payload.toString());
    data.deviceId  = deviceId;
    data.lastSeen  = new Date().toISOString();

    // Atualizar estado em memória
    deviceStatus[deviceId] = data;

    // Broadcast para todos os clientes WebSocket conectados
    broadcastToWS({
      type:     'status',
      deviceId: deviceId,
      data:     data,
    });

    console.log(`[MQTT→WS] ${deviceId}: temp=${data.temp} cond=${data.cond}`);
  } catch (e) {
    console.error('[MQTT] Erro ao processar mensagem:', e.message);
  }
});

// ============================================================
// WEBSOCKET SERVER
// ============================================================
const wsClients = new Map(); // { ws: { deviceIds: [] } }

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Nova conexão de ${ip}`);

  wsClients.set(ws, { subscribedDevices: [] });

  // Enviar lista de dispositivos conhecidos ao conectar
  ws.send(JSON.stringify({
    type:    'devices_list',
    devices: Object.keys(deviceStatus),
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Autenticação
      if (msg.type === 'auth') {
        if (msg.secret === WS_SECRET) {
          const info = wsClients.get(ws);
          info.authenticated = true;
          wsClients.set(ws, info);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          console.log(`[WS] Cliente autenticado (${ip})`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
          ws.close();
        }
        return;
      }

      // Verificar autenticação para comandos
      const info = wsClients.get(ws);
      if (!info || !info.authenticated) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Não autenticado' }));
        return;
      }

      // Subscrever em dispositivos específicos
      if (msg.type === 'subscribe') {
        info.subscribedDevices = Array.isArray(msg.devices) ? msg.devices : [];
        wsClients.set(ws, info);
        // Enviar status atual imediatamente
        info.subscribedDevices.forEach((id) => {
          if (deviceStatus[id]) {
            ws.send(JSON.stringify({
              type:     'status',
              deviceId: id,
              data:     deviceStatus[id],
            }));
          }
        });
        ws.send(JSON.stringify({ type: 'subscribed', devices: info.subscribedDevices }));
        return;
      }

      // Encaminhar comando MQTT para o dispositivo
      if (msg.type === 'cmd') {
        const { deviceId, payload: cmdPayload } = msg;
        if (!deviceId || !cmdPayload) {
          ws.send(JSON.stringify({ type: 'error', msg: 'deviceId e payload obrigatórios' }));
          return;
        }
        const topic = `hf006/${deviceId}/cmd`;
        const json  = JSON.stringify(cmdPayload);
        mqttClient.publish(topic, json, { qos: 1 }, (err) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'cmd_fail', msg: err.message }));
          } else {
            ws.send(JSON.stringify({ type: 'cmd_ok', deviceId, payload: cmdPayload }));
            console.log(`[WS→MQTT] ${topic}: ${json}`);
          }
        });
        return;
      }

      // Solicitar status atual de um dispositivo
      if (msg.type === 'get_status') {
        const id = msg.deviceId;
        if (deviceStatus[id]) {
          ws.send(JSON.stringify({ type: 'status', deviceId: id, data: deviceStatus[id] }));
        } else {
          ws.send(JSON.stringify({ type: 'status_not_found', deviceId: id }));
        }
        return;
      }

    } catch (e) {
      console.error('[WS] Erro ao processar mensagem:', e.message);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Conexão encerrada (${ip})`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Erro:', err.message);
    wsClients.delete(ws);
  });
});

function broadcastToWS(message) {
  const json = JSON.stringify(message);
  wsClients.forEach((info, ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!info.authenticated) return;

    // Enviar apenas para clientes que subscreveram este dispositivo,
    // ou para todos se a lista estiver vazia (sem filtro)
    const subs = info.subscribedDevices;
    if (subs.length === 0 || subs.includes(message.deviceId)) {
      ws.send(json);
    }
  });
}

// ============================================================
// REST API (para integração alternativa com Bubble via API Connector)
// ============================================================

// Listar todos os dispositivos e seus últimos status
app.get('/api/devices', (req, res) => {
  if (!checkApiKey(req)) return res.status(401).json({ error: 'Não autorizado' });
  res.json({
    devices: Object.entries(deviceStatus).map(([id, data]) => ({
      id,
      ...data,
    })),
  });
});

// Status de um dispositivo específico
app.get('/api/devices/:id', (req, res) => {
  if (!checkApiKey(req)) return res.status(401).json({ error: 'Não autorizado' });
  const data = deviceStatus[req.params.id];
  if (!data) return res.status(404).json({ error: 'Dispositivo não encontrado' });
  res.json(data);
});

// Enviar comando para um dispositivo
app.post('/api/devices/:id/cmd', (req, res) => {
  if (!checkApiKey(req)) return res.status(401).json({ error: 'Não autorizado' });
  const deviceId = req.params.id;
  const cmdPayload = req.body;

  if (!cmdPayload || !cmdPayload.cmd) {
    return res.status(400).json({ error: 'Campo "cmd" obrigatório no body' });
  }

  const topic = `hf006/${deviceId}/cmd`;
  const json  = JSON.stringify(cmdPayload);

  mqttClient.publish(topic, json, { qos: 1 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    console.log(`[REST→MQTT] ${topic}: ${json}`);
    res.json({ ok: true, topic, payload: cmdPayload });
  });
});

function checkApiKey(req) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  return key === WS_SECRET;
}

// Health check (Render requer rota respondendo para manter o serviço ativo)
app.get('/health', (req, res) => {
  res.json({
    status:       'ok',
    mqtt:         mqttClient.connected ? 'connected' : 'disconnected',
    ws_clients:   wsClients.size,
    devices_known: Object.keys(deviceStatus).length,
    uptime_s:     Math.floor(process.uptime()),
  });
});

app.get('/', (req, res) => {
  res.json({ service: 'HF-006 MQTT-WS Bridge', version: '1.0.0' });
});

// ============================================================
// START SERVER
// ============================================================
server.listen(PORT, () => {
  console.log(`\n=== HF-006 MQTT-WS Bridge ===`);
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`MQTT Broker: ${MQTT_BROKER_URL}`);
  console.log(`Health: http://localhost:${PORT}/health\n`);
});
