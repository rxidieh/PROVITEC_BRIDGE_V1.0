# HF-006 MQTT-WebSocket Bridge — Deploy no Render

## Arquivos deste diretório

| Arquivo | Descrição |
|---|---|
| `server.js` | Servidor Node.js principal |
| `package.json` | Dependências npm |
| `render.yaml` | Configuração de deploy no Render |

## Passos para Deploy

### 1. Criar repositório GitHub

Crie um repositório no GitHub e faça push dos arquivos desta pasta:

```bash
git init
git add .
git commit -m "HF-006 bridge v1.0"
git remote add origin https://github.com/SEU_USUARIO/hf006-bridge.git
git push -u origin main
```

### 2. Criar serviço no Render

1. Acesse https://render.com e faça login
2. Clique em **New → Web Service**
3. Conecte ao repositório GitHub criado
4. Configure:
   - **Name:** `hf006-mqtt-ws-bridge`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

### 3. Configurar variáveis de ambiente

No painel do Render, vá em **Environment** e adicione:

| Variável | Valor | Descrição |
|---|---|---|
| `MQTT_URL` | `mqtts://xxxx.s1.eu.hivemq.cloud:8883` | URL do seu cluster HiveMQ |
| `MQTT_USER` | `seu_usuario_hivemq` | Usuário criado no HiveMQ |
| `MQTT_PASS` | `sua_senha_hivemq` | Senha do HiveMQ |
| `WS_SECRET` | `string_aleatoria_forte` | Chave para autenticar Bubble |

**Como gerar WS_SECRET:**
```bash
openssl rand -hex 32
# Exemplo: a3f8c2d1e4b7a9f0c3e2d5b8a1f4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2
```

### 4. Verificar deploy

Após o deploy (2-3 min), acesse:
```
https://hf006-mqtt-ws-bridge.onrender.com/health
```

Resposta esperada:
```json
{
  "status": "ok",
  "mqtt": "connected",
  "ws_clients": 0,
  "devices_known": 0,
  "uptime_s": 42
}
```

---

## Protocolo WebSocket

### Autenticação (obrigatória após conectar)
```json
{ "type": "auth", "secret": "SUA_WS_SECRET" }
```

### Subscrever dispositivos
```json
{ "type": "subscribe", "devices": ["PLACA01", "PLACA02"] }
```

### Receber status (enviado automaticamente pelo broker)
```json
{
  "type": "status",
  "deviceId": "PLACA01",
  "data": {
    "hora": "14:30:00",
    "temp": "25.3",
    "cond": "850",
    "lit_entrada": 1250,
    "lit_saida": 1200,
    "relay1": false,
    "relay2": false,
    "relay3": false,
    "alarme_cond": false,
    "prox_dosagem": "18:00 (Canal 1)"
  }
}
```

### Enviar comando
```json
{
  "type": "cmd",
  "deviceId": "PLACA01",
  "payload": {
    "cmd": "manual_relay",
    "relay": 1,
    "tempo_s": 60
  }
}
```

### Comandos disponíveis

| cmd | Parâmetros | Descrição |
|---|---|---|
| `manual_relay` | `relay` (1-3), `tempo_s` | Acionar relé manualmente |
| `set_dosagem` | `idx`, `ativo`, `canal`, `dia`, `hora`, `minuto`, `duracao` | Programar dosagem |
| `reset_totais` | — | Zerar totalizadores de vazão |
| `set_alarme` | `setpoint`, `histerese` | Configurar alarme de condutividade |

---

## REST API (alternativa ao WebSocket)

Todos os endpoints exigem header: `x-api-key: SUA_WS_SECRET`

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/devices` | Lista todos os dispositivos |
| GET | `/api/devices/:id` | Status de um dispositivo |
| POST | `/api/devices/:id/cmd` | Enviar comando |

**Exemplo — Acionar bomba via REST:**
```bash
curl -X POST https://hf006-mqtt-ws-bridge.onrender.com/api/devices/PLACA01/cmd \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_WS_SECRET" \
  -d '{"cmd":"manual_relay","relay":1,"tempo_s":30}'
```

---

## Notas importantes

- **Plano Free do Render:** o serviço "hiberna" após 15 min sem requisições.
  Para manter ativo, use um serviço de ping (ex: UptimeRobot em `/health` a cada 5 min).
- **HiveMQ Cloud Free:** limite de 100 conexões simultâneas e 10GB/mês de tráfego.
- O bridge mantém o último status de cada placa em memória (reinicia ao reiniciar o serviço).
