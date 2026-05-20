# 13 — Túnel Móvil para MercadoLibre (Pusher + React Native)

MercadoLibre bloquea sistemáticamente las IPs de datacenter (Webshare, hosting compartido, VPS) redirigiéndolas a `/gz/account-verification`. Para sortearlo sin pagar proxies residenciales, Topo delega esa consulta a una **flota de teléfonos físicos** (app React Native "Topo Túnel") que corren con IP residencial real.

> Documentos hermanos: `docs/14-actualizaciones-incrementales.md` (qué subir/ejecutar al desplegar este módulo en hosting compartido), `docs/08-despliegue-hosting-compartido.md` (deploy completo desde cero).

---

## 1. Arquitectura: quién habla con quién

Hay **3 actores** y **los 3 se conectan a la misma app de Pusher** (misma `APP_KEY` pública, mismo `cluster`). Todo el flujo es **tiempo real puro vía WebSocket; cero polling**.

```text
┌───────────────────────┐       REST (HTTP/JSON)        ┌─────────────────────────┐
│  Frontend web (React) │  ── POST /api/v1/compare ──►  │   Backend Laravel       │
│  topo (este proyecto) │                               │   (este proyecto)       │
└───────────┬───────────┘                               └────────┬────────────────┘
            │ Pusher (escucha)                                    │ Pusher (publica)
            │ canal: ml-task.{id}                                 │ APP_ID+KEY+SECRET
            │ evento: MlResultsReady                              │
            │                                                     │
            │                                                     ▼
            │                                       ┌────────────────────────────┐
            │                                       │  App móvil React Native    │
            │                                       │  "topo-tunel-app"          │
            │                                       │  Pusher (escucha)          │
            │                                       │  canal: scraper-tasks      │
            │                                       │  evento: NewScrapingTask   │
            │                                       └────────┬───────────────────┘
            │                                                │ REST: claim/callback/release
            └────── la MISMA app de Pusher ◄─────────────────┘
```

- **Una sola app de Pusher** (`topo-tunel`, cluster `us2`) sirve a los 3 clientes simultáneamente. La `APP_KEY` es **pública por diseño**; el `APP_SECRET` es exclusivo del backend (es el único que **publica** eventos).
- **Frontend web ↔ Backend (REST)**: el navegador envía la consulta a `POST /api/v1/compare` y recibe inmediatamente los resultados de todas las tiendas excepto MercadoLibre, junto con un `ml_task_id`.
- **Frontend web ↔ Pusher (WebSocket)**: en cuanto recibe ese `ml_task_id`, se suscribe al canal `ml-task.{id}` y espera el evento `MlResultsReady`. Sin polling, sin segundos perdidos.
- **Backend ↔ App móvil (Pusher)**: Laravel publica `NewScrapingTask` en `scraper-tasks`. Los teléfonos compiten por reclamar la tarea (Claim-Lock) y devuelven el HTML por REST.
- **Backend → Frontend web (Pusher)**: cuando Laravel parsea el HTML, publica `MlResultsReady` en `ml-task.{id}`. El frontend lo recibe en ~50 ms y concatena los productos a la tabla.

---

## 2. Flujo end-to-end (tiempo real puro)

1. El usuario busca un producto → `POST /api/v1/compare`.
2. Laravel responde **inmediatamente** con los resultados de Alkosto, Éxito, Jumbo, Olímpica, etc. y crea un registro en `scraping_tasks` (estado `pending`). La respuesta incluye `ml_task_id`.
3. **El frontend web abre un WebSocket a Pusher** y se suscribe al canal `ml-task.{id}`.
4. Laravel emite `NewScrapingTask` por Pusher al canal público `scraper-tasks`.
5. Todos los teléfonos React Native activos reciben el evento y compiten por reclamar la tarea vía `POST /api/v1/scraper/claim`. Solo el primero gana (`200 OK`); los demás reciben `409`.
6. El teléfono ganador hace el `GET` a `https://listado.mercadolibre.com.co/{slug}` con IP residencial y devuelve el HTML crudo (`POST /api/v1/scraper/callback`). Si el teléfono reporta una falla de conexión o timeout, notifica vía `POST /api/v1/scraper/release` para que la tarea sea liberada y reintentada por otro teléfono.
7. Laravel parsea el HTML con `MercadoLibreScraper::parseHtmlPayload()`, guarda los resultados (`status = completed`) y **emite `MlResultsReady` por Pusher al canal `ml-task.{id}`**.
8. El frontend web recibe el evento por WebSocket y concatena los productos a la tabla que el usuario ya está viendo. Latencia típica end-to-end: 2–8 segundos (limitada solo por lo que tarde MercadoLibre + el teléfono, no por polling).

Si ningún teléfono responde en 35 s, el frontend cierra el indicador silenciosamente. El cron `scrapers:purge-tunnel-tasks` además emite `MlResultsReady` con `status: failed` para que el spinner cierre incluso si el navegador estuvo en background.

---

## 3. Configuración de Pusher (los 3 actores, misma app)

### 3.0 Crear la app en Pusher Channels (paso a paso)

Pusher Channels es el servicio WebSocket que conecta los **3 actores** en tiempo real con **una sola app**. La misma `APP_KEY` pública la usan: el **backend Laravel** (que además tiene el `SECRET` para publicar), la **app móvil React Native `topo-tunel-app`** (que escucha tareas y procesa el scraping) y el **frontend web React** de este proyecto (que escucha resultados de ML para mostrarlos al usuario sin recargar).

**Pasos en el dashboard de Pusher:**

1. Entra a [https://dashboard.pusher.com/](https://dashboard.pusher.com/) y crea una cuenta gratuita (plan Sandbox: 200k mensajes/día, **100 conexiones simultáneas** — suficiente para Topo: cada navegador abierto cuenta como 1, cada teléfono como 1).
2. Pulsa **"Create app"** o **"+ New app"**.
3. **Name your app**: `topo-tunel` (etiqueta interna del dashboard; no aparece en código).
4. **Select a cluster**: `us2 (US East - Ohio)` — el más cercano a Colombia, latencia ~50 ms. Este valor **debe coincidir exactamente** en `PUSHER_APP_CLUSTER`, `VITE_PUSHER_CLUSTER` y el `cluster` del SDK móvil.
5. **Create apps for multiple environments?**: **dejar sin marcar.**
6. **Choose your tech stack (opcional)** — solo afecta los snippets de ejemplo:
   - **Front end**: puedes elegir **React** (frontend web) o **React Native** (app móvil); los snippets aplican a ambos, son intercambiables desde el desplegable "Getting started".
   - **Back end**: **Laravel**.
7. Pulsa **"Create app"**.

**Después de crearla**, abre la pestaña **"App Keys"** y copia los 4 valores:

| Valor en el dashboard | Variable en Topo | Dónde se usa |
|---|---|---|
| `app_id` | `PUSHER_APP_ID` | **Solo** backend Laravel (`.env`) |
| `key` | `PUSHER_APP_KEY` + `VITE_PUSHER_KEY` + `apiKey` del SDK móvil | **Los 3 actores** (es **pública** por diseño, segura de exponer en el bundle JS y en la app) |
| `secret` | `PUSHER_APP_SECRET` | **SOLO** backend Laravel. **NUNCA** en el frontend ni en la app móvil. |
| `cluster` | `PUSHER_APP_CLUSTER` + `VITE_PUSHER_CLUSTER` + `cluster` del SDK móvil | **Los 3 actores** |

> Las variables `VITE_PUSHER_KEY` y `VITE_PUSHER_CLUSTER` son embebidas por Vite en el bundle JS en tiempo de build. **Si las cambias, hay que recompilar (`npm run build`)** y volver a subir `dist/` al hosting.

**Configuraciones extra recomendadas** (pestaña **"App Settings"**):

- **Enable client events**: dejar **desactivado**. Toda emisión va por el backend.
- **Enable authorized connections**: dejar **desactivado**. Los canales `scraper-tasks` y `ml-task.{id}` son **públicos** (sin prefijo `private-` ni `presence-`) y no requieren autenticación. Esto simplifica enormemente la integración: ni la app móvil ni el frontend web necesitan endpoint `/broadcasting/auth`.
- **TLS only**: dejar **activado** (es el default). Todos los clientes conectan vía `wss://`.

### 3.1 Backend (Laravel)

1. `composer require pusher/pusher-php-server` (ya declarado en `composer.json`).
2. Variables en `.env` (copiar desde el dashboard de Pusher, §3.0):

   ```env
   BROADCAST_CONNECTION=pusher
   ML_TUNNEL_ENABLED=true
   PUSHER_APP_ID=2157151
   PUSHER_APP_KEY=39c32a0c95b80ddf3123
   PUSHER_APP_SECRET=3a70842b278c4c58727f
   PUSHER_APP_CLUSTER=us2
   ```

3. `php artisan migrate` crea la tabla `scraping_tasks`.
4. Cron (ya programado en `routes/console.php`): `php artisan schedule:run` cada minuto purga tareas colgadas > 90 s.
5. Tras editar `.env`: `run_setup.php` → **Limpiar TODA la caché** (sin esto Laravel sigue usando el driver `log` cacheado).

### 3.2 Frontend web (React + Vite) — cliente Pusher de solo lectura

El frontend web se suscribe al canal `ml-task.{id}` por WebSocket en cuanto recibe un `ml_task_id` en la respuesta de `/compare`. Necesita **solo dos variables públicas** en el `.env` (Vite las embebe en el bundle al hacer `npm run build`):

```env
VITE_PUSHER_KEY=39c32a0c95b80ddf3123        # MISMA APP_KEY que el backend (publica, segura)
VITE_PUSHER_CLUSTER=us2                      # MISMO cluster
```

Dependencias instaladas (`package.json`): `laravel-echo`, `pusher-js`.

```ts
// src/services/echo.ts  (extracto)
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
(window as any).Pusher = Pusher;
const echo = new Echo({
  broadcaster: 'pusher',
  key: import.meta.env.VITE_PUSHER_KEY,
  cluster: import.meta.env.VITE_PUSHER_CLUSTER ?? 'us2',
  forceTLS: true,
  enabledTransports: ['ws', 'wss'],
});
```

```ts
// src/components/comparison/PriceComparisonSection.tsx  (extracto)
echo.channel(`ml-task.${taskId}`).listen('.MlResultsReady', (payload) => {
  if (payload.status === 'completed') concatenarResultados(payload.results);
});
```

### 3.3 App móvil React Native (`topo-tunel-app`) — cliente Pusher de tareas

La app móvil **NO necesita `APP_SECRET`** (solo el backend lo conoce). Usa únicamente la `APP_KEY` pública y el cluster:

```ts
// SDK oficial recomendado por Pusher para RN:
import { Pusher } from '@pusher/pusher-websocket-react-native';

const pusher = Pusher.getInstance();
await pusher.init({
  apiKey: '39c32a0c95b80ddf3123',  // MISMA APP_KEY que backend y frontend web
  cluster: 'us2',                    // MISMO cluster
});
await pusher.connect();
await pusher.subscribe({
  channelName: 'scraper-tasks',
  onEvent: (event) => { /* manejar NewScrapingTask */ },
});
```

---

## 4. Endpoints HTTP

Base URL: `https://topo.saedi.com.co/api/v1`

### 4.1 Endpoints consumidos por la app móvil React Native

#### `POST /scraper/claim`

Reclamación atómica de una tarea. Solo el primer worker que llega recibe `success: true`.

**Request body (JSON):**

```json
{
  "task_id": 1045,
  "worker_id": "phone-andres-pixel7"
}
```

**Headers obligatorios:** `Accept: application/json`, `Content-Type: application/json`.

**Respuestas:**

- `200 OK` — ganaste la tarea, procesa:

  ```json
  {
    "success": true,
    "task_id": 1045,
    "url": "https://listado.mercadolibre.com.co/iphone-17-pro-max",
    "query": "iPhone 17 Pro Max"
  }
  ```

- `409 Conflict` — otro teléfono se adelantó. **Ignora silenciosamente** y vuelve a escuchar.

  ```json
  { "success": false, "reason": "already_claimed" }
  ```

- `422` — payload inválido (faltó `task_id` o `worker_id`).

#### `POST /scraper/callback`

Entrega del HTML crudo al backend. **Solo el worker que ganó el claim puede llamar este endpoint.**

**Request body (JSON):**

```json
{
  "task_id": 1045,
  "worker_id": "phone-andres-pixel7",
  "html": "<!DOCTYPE html><html>...HTML COMPLETO DE LA PÁGINA DE ML..."
}
```

> El campo `html` puede ser muy grande (hasta ~2 MB). Envíalo con `Content-Type: application/json` y **no lo comprimas**.

**Respuestas:**

- `200 OK` — Laravel parseó el HTML: `{ "success": true, "count": 18 }`
- `404 Not Found` — la tarea ya no existe (fue purgada). Descártala.
- `409 Conflict` — la tarea cambió de estado o tú no eres el dueño.
- `500` — el HTML no contenía items reconocibles. Laravel ya marcó la tarea como `failed`.

#### `POST /scraper/release`

Liberar una tarea cuando tu request a ML expiró o falló. La tarea vuelve a `pending` y otro worker puede reclamarla. Tras 3 releases se marca como `failed` definitivamente.

```json
{ "task_id": 1045, "worker_id": "phone-andres-pixel7" }
```

### 4.2 Endpoint consumido por el frontend web (fallback/polling opcional)

#### `GET /scraper/task/{id}`

Devuelve el estado actual de una tarea.

**Respuesta:**

```json
{
  "task_id": 1045,
  "status": "completed",
  "results": [ { "store": "MercadoLibre", "title": "...", "price": 4500000, "...": "..." } ],
  "count": 18
}
```

Valores posibles de `status`: `pending` | `processing` | `completed` | `failed`. Mientras no sea `completed`, `results` viene vacío.

---

## 5. Payload del evento `NewScrapingTask` (canal Pusher)

Laravel emite el evento como `ShouldBroadcastNow` con `broadcastAs: 'NewScrapingTask'`. La trama que llega al WebSocket de Pusher es:

```json
{
  "event": "NewScrapingTask",
  "channel": "scraper-tasks",
  "data": "{\"task_id\":1045,\"url\":\"https://listado.mercadolibre.com.co/iphone-17-pro-max\",\"query\":\"iPhone 17 Pro Max\"}"
}
```

---

## 6. Detalles técnicos para el equipo de la app móvil (topo-tunel-app)

### 6.1 Conexión a Pusher

La app móvil utiliza el SDK oficial `@pusher/pusher-websocket-react-native`.

*   El canal es **público** (`scraper-tasks`, sin prefijo `private-`/`presence-`). No hay endpoint `/broadcasting/auth`.
*   **Nunca** incluir `PUSHER_APP_SECRET` en la app móvil. Solo `APP_KEY` y `cluster`.

### 6.2 Flujo real implementado en el Worker móvil

A continuación se muestra el código real implementado en `src/services/WorkerService.js` utilizando **Axios** para networking y el SDK oficial de **Pusher**:

```javascript
  // Fragmento de control de scraping en la App Móvil
  async processTask(task) {
    if (!task || !task.task_id || !task.url) return;
    this.notifyStatus('Procesando Tarea');

    try {
      // 1. Reclamo de la tarea (Claim)
      let claimRes;
      try {
        claimRes = await axios.post(`${API_BASE}/claim`, {
          task_id: task.task_id,
          worker_id: this.workerId,
        });
      } catch (err) {
        // Ignora silenciosamente si devuelve 409 (Otro worker se adelantó)
        this.notifyStatus('Conectado');
        return;
      }

      if (!claimRes.data || !claimRes.data.success) {
        this.notifyStatus('Conectado');
        return;
      }

      // 2. Scraping HTTP GET
      let html;
      try {
        const scrapeRes = await axios.get(task.url, {
          headers: {
            'User-Agent': MOBILE_USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
          },
          timeout: 15000, // Timeout de 15 segundos
        });
        html = scrapeRes.data;
      } catch (scrapeErr) {
        // En caso de fallo/timeout, liberar la tarea (Release)
        try {
          await axios.post(`${API_BASE}/release`, {
            task_id: task.task_id,
            worker_id: this.workerId,
          });
        } catch (releaseErr) {
          console.error('Error al liberar tarea:', releaseErr.message);
        }
        return;
      }

      // 3. Envío de resultados (Callback)
      await axios.post(`${API_BASE}/callback`, {
        task_id: task.task_id,
        worker_id: this.workerId,
        html: html,
      });

      if (this.onTaskCompleted) {
        this.onTaskCompleted();
      }
    } catch (error) {
      console.error('Error en proceso de tarea:', error.message);
    } finally {
      if (this.isActive) {
        this.notifyStatus('Conectado');
      }
    }
  }
```

### 6.3 Reglas críticas del cliente móvil

- **NO parsees el HTML en el móvil.** El backend usa Symfony DomCrawler con selectores que pueden cambiar; mantener la lógica en un solo lugar evita actualizar la app cada vez que ML cambia la maquetación.
- **Timeout de 15 s** en el `fetch` a MercadoLibre. Si excede → `release`. Si no liberas, la tarea queda `processing` hasta que el cron `scrapers:purge-tunnel-tasks` la limpie (hasta 90 s).
- **`worker_id` único y estable por teléfono.** Recomendación: `${deviceName}-${installId}` persistido en `AsyncStorage`. Si cambia entre claim y callback, el backend rechaza el callback con `409 not_owner_or_state`.
- **Detección de bot-challenge**: si el HTML contiene `account-verification`, `Verifica que eres una persona` o `gz-verify`, envíalo igual. Laravel lo detecta y marca la tarea como `failed`; el frontend web cierra el spinner gracias al polling.
- **Headers User-Agent**: rota entre varios User-Agents móviles realistas para evitar fingerprinting.
- **Reconexión automática**: los SDK de Pusher reconectan solos si pierden la conexión. Loguea `connection.state_change` para diagnóstico.

---

## 7. Troubleshooting

### Backend / Laravel

| Síntoma | Causa probable | Solución |
|---|---|---|
| `Class "Pusher\Pusher" not found` | Falta el paquete `pusher/pusher-php-server` | Subir `vendor/` regenerado tras `composer require`. |
| `SQLSTATE Table 'scraping_tasks' doesn't exist` | Falta correr la migración | Ejecutar migraciones en el backend. |
| Frontend ve `ml_task_id` pero el túnel nunca responde | Pusher mal configurado en backend o ningún teléfono escuchando | Revisar Debug Console de Pusher; verificar `BROADCAST_CONNECTION=pusher`. |

### App móvil

| Síntoma | Causa probable | Solución |
|---|---|---|
| No llega ningún `NewScrapingTask` | `APP_KEY` o `cluster` distintos al backend | Comparar byte a byte con `PUSHER_APP_KEY`/`PUSHER_APP_CLUSTER`. |
| `claim` siempre devuelve 409 | Otros teléfonos más rápidos, o tarea ya expirada | Comportamiento normal; ignorar y seguir escuchando. |
| `callback` devuelve 409 `not_owner_or_state` | `worker_id` cambió entre claim y callback | Persistir `worker_id` en `AsyncStorage` desde el primer arranque. |
