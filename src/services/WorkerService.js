import axios from 'axios';
import notifee, { AndroidImportance } from '@notifee/react-native';
import { Pusher } from '@pusher/pusher-websocket-react-native';

const API_BASE = 'https://topo.saedi.com.co/api/v1/scraper';

// Use a realistic mobile user agent
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

class WorkerService {
  constructor() {
    this.pusher = null;
    this.workerId = null;
    this.isActive = false;
    this.onTaskCompleted = null;
    this.onStatusChange = null;
    this.onMetricsUpdate = null;
    this.onWebViewRenderRequest = null;
    this.reconnectTimeout = null;
    this.bytesSent = 0;
    this.bytesReceived = 0;

    // ── Cola FIFO: solo una instancia de WebView activa a la vez ──────────
    this.webviewQueue = [];     // [{task, resolve, reject}]
    this.webviewBusy  = false;

    // Intercept outbound requests to calculate bytes sent
    axios.interceptors.request.use((config) => {
      if (this.isActive && config.data) {
        const payloadStr = typeof config.data === 'string' ? config.data : JSON.stringify(config.data);
        this.bytesSent += payloadStr.length;
        this.notifyMetrics();
      }
      return config;
    });

    // Intercept incoming responses to calculate bytes received
    axios.interceptors.response.use((response) => {
      if (this.isActive && response.data) {
        const payloadStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        this.bytesReceived += payloadStr.length;
        this.notifyMetrics();
      }
      return response;
    });
  }

  init(workerId, onTaskCompleted, onStatusChange, onMetricsUpdate, onWebViewRenderRequest) {
    this.workerId = workerId;
    this.onTaskCompleted = onTaskCompleted;
    this.onStatusChange = onStatusChange;
    this.onMetricsUpdate = onMetricsUpdate;
    this.onWebViewRenderRequest = onWebViewRenderRequest;
  }

  async start() {
    if (this.isActive) return;
    this.isActive = true;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.notifyMetrics();
    
    // Start Foreground Service
    await this.startForegroundService();

    this.connectPusher();
  }

  async stop() {
    this.isActive = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.pusher) {
      try {
        await this.pusher.unsubscribe({ channelName: 'scraper-tasks' });
        await this.pusher.disconnect();
      } catch (err) {
        console.error('Error disconnecting Pusher:', err);
      }
      this.pusher = null;
    }
    await this.stopForegroundService();
    this.notifyStatus('Desconectado');
  }

  async startForegroundService() {
    await this.updateNotification(
      'Topo Túnel: Activo',
      'Iniciando enlace del servicio...',
      '#3b82f6'
    );
  }

  async updateNotification(title, body, color) {
    try {
      // Create a channel (required for Android)
      const channelId = await notifee.createChannel({
        id: 'tunnel-service',
        name: 'Topo Túnel Service',
        importance: AndroidImportance.LOW,
      });

      // Display or update the notification with a persistent ID
      await notifee.displayNotification({
        id: 'tunnel-status-notification',
        title: title,
        body: body,
        android: {
          channelId,
          asForegroundService: true,
          ongoing: true,
          color: color || '#10b981',
          pressAction: {
            id: 'default',
          },
          actions: [
            {
              title: 'Detener Túnel',
              pressAction: {
                id: 'stop-tunnel',
              },
            },
          ],
        },
      });
    } catch (e) {
      console.error('Error displaying notification:', e);
    }
  }

  async stopForegroundService() {
    try {
      await notifee.stopForegroundService();
    } catch (e) {
      console.error('Error stopping foreground service:', e);
    }
  }

  async connectPusher() {
    if (!this.isActive) return;

    try {
      this.pusher = Pusher.getInstance();

      await this.pusher.init({
        apiKey: '39c32a0c95b80ddf3123', // MISMA APP_KEY que backend y frontend web
        cluster: 'us2',                  // MISMO cluster
        onConnectionStateChange: (currentState, previousState) => {
          console.log(`Pusher connection state: ${previousState} -> ${currentState}`);
          
          if (currentState === 'CONNECTED') {
            this.notifyStatus('Conectado');
          } else if (currentState === 'CONNECTING') {
            this.notifyStatus('Conectando...');
          } else if (currentState === 'RECONNECTING') {
            this.notifyStatus('Reconectando...');
          } else if (currentState === 'DISCONNECTED') {
            this.notifyStatus('Desconectado');
          }
        },
        onError: (message, code, error) => {
          console.log(`Pusher error: ${message} (code ${code})`);
        }
      });

      await this.pusher.connect();

      await this.pusher.subscribe({
        channelName: 'scraper-tasks',
        onEvent: async (event) => {
          console.log(`Received event: ${event.eventName}`);
          if (event.eventName === 'NewScrapingTask') {
            try {
              let taskData = event.data;
              if (typeof taskData === 'string') {
                taskData = JSON.parse(taskData);
              }
              await this.processTask(taskData);
            } catch (err) {
              console.error('Error parsing task data:', err);
            }
          }
        }
      });
    } catch (e) {
      console.error('Error initializing Pusher:', e);
      if (this.isActive) {
        this.notifyStatus('Reconectando...');
        this.reconnectTimeout = setTimeout(() => this.connectPusher(), 3000);
      }
    }
  }

  /**
   * Encola una tarea WebView y garantiza que solo haya una instancia activa.
   * Resuelve con el payload enriquecido cuando el WebView termina.
   */
  _enqueueWebView(task) {
    return new Promise((resolve, reject) => {
      this.webviewQueue.push({ task, resolve, reject });
      this._drainWebViewQueue();
    });
  }

  _drainWebViewQueue() {
    if (this.webviewBusy || this.webviewQueue.length === 0) return;
    this.webviewBusy = true;
    const { task, resolve, reject } = this.webviewQueue.shift();

    if (!this.onWebViewRenderRequest) {
      this.webviewBusy = false;
      reject(new Error('WebView renderer not bound'));
      return;
    }

    this.onWebViewRenderRequest(task, (resultPayload) => {
      this.webviewBusy = false;
      this._drainWebViewQueue(); // procesar siguiente en cola
      if (resultPayload && resultPayload.html) {
        // Contabilizar bytes recibidos
        this.bytesReceived += resultPayload.html.length;
        this.notifyMetrics();
        resolve(resultPayload);
      } else {
        reject(new Error('WebView no devolvió HTML válido'));
      }
    });
  }

  async processTask(task) {
    if (!task || !task.task_id || !task.url) return;
    
    console.log(`[Worker] Tarea recibida: ${task.task_id} render_mode=${task.render_mode}`);
    this.notifyStatus('Procesando Tarea');

    try {
      // 1. Claim the task
      let claimRes;
      try {
        claimRes = await axios.post(`${API_BASE}/claim`, {
          task_id: task.task_id,
          worker_id: this.workerId,
        });
      } catch (err) {
        console.log(`[Worker] Claim fallido para tarea ${task.task_id}:`, err.message);
        this.notifyStatus('Conectado');
        return;
      }

      if (!claimRes.data || !claimRes.data.success) {
        console.log(`[Worker] Tarea ${task.task_id} ya reclamada por otro worker.`);
        this.notifyStatus('Conectado');
        return;
      }

      // Mezclar hints que puede traer la respuesta del claim con los del evento Pusher
      const claimedTask = { ...task, ...claimRes.data };
      console.log(`[Worker] Tarea ${claimedTask.task_id} reclamada. render_mode=${claimedTask.render_mode}`);

      // 2. Scrape
      // NUNCA usar axios/fetch si render_mode === 'webview'
      let resultPayload;
      if (claimedTask.render_mode === 'webview') {
        console.log(`[Worker] Delegando tarea ${claimedTask.task_id} al WebView...`);
        try {
          resultPayload = await this._enqueueWebView(claimedTask);
        } catch (webviewErr) {
          console.error(`[Worker] WebView falló para ${claimedTask.task_id}:`, webviewErr.message);
          // Liberar tarea para que otro worker pueda intentarlo
          try {
            await axios.post(`${API_BASE}/release`, {
              task_id: claimedTask.task_id,
              worker_id: this.workerId,
            });
          } catch (_) {}
          return;
        }
      } else {
        try {
          const scrapeRes = await axios.get(claimedTask.url, {
            headers: {
              'User-Agent': claimedTask.user_agent || MOBILE_USER_AGENT,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'es-CO,es;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            timeout: claimedTask.wait_timeout_ms || 15000,
          });
          resultPayload = { html: scrapeRes.data, reason: 'fetch_ok', task_id: claimedTask.task_id, worker_id: this.workerId };
        } catch (fetchErr) {
          console.error(`[Worker] Fetch falló para ${claimedTask.task_id}:`, fetchErr.message);
          try {
            await axios.post(`${API_BASE}/release`, {
              task_id: claimedTask.task_id,
              worker_id: this.workerId,
            });
          } catch (_) {}
          return;
        }
      }

      // 3. Callback con payload enriquecido
      try {
        const callbackRes = await axios.post(`${API_BASE}/callback`, {
          task_id:     claimedTask.task_id,
          worker_id:   this.workerId,
          html:        resultPayload.html,
          reason:      resultPayload.reason,
          elapsed:     resultPayload.elapsed,
          url:         resultPayload.url,
          title:       resultPayload.title,
          len:         resultPayload.len,
          hasListing:  resultPayload.hasListing,
          isChallenge: resultPayload.isChallenge,
          isAccount:   resultPayload.isAccount,
        });

        // El backend puede responder 422 si detecta que envié micro-landing
        if (callbackRes.data && callbackRes.data.success === false && callbackRes.data.reason === 'anti_bot_detected') {
          console.warn(`[Worker] Backend rechazó HTML (anti_bot_detected) para tarea ${claimedTask.task_id}. La tarea volverá a la cola.`);
        } else {
          console.log(`[Worker] Tarea ${claimedTask.task_id} completada. hasListing=${resultPayload.hasListing}`);
          if (this.onTaskCompleted) this.onTaskCompleted();
        }
      } catch (callbackErr) {
        // 422: backend rechazó el HTML (fue micro-landing). La tarea vuelve a pending automáticamente.
        if (callbackErr.response && callbackErr.response.status === 422) {
          console.warn(`[Worker] 422 anti_bot_detected para tarea ${claimedTask.task_id}. El backend re-encola.`);
        } else {
          console.error(`[Worker] Error en callback para ${claimedTask.task_id}:`, callbackErr.message);
        }
      }

    } catch (error) {
      console.error(`[Worker] Error general en processTask ${task.task_id}:`, error.message);
    } finally {
      if (this.isActive) {
        this.notifyStatus('Conectado');
      }
    }
  }

  notifyStatus(status) {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }

    if (this.isActive) {
      let title = 'Topo Túnel: Activo';
      let body = 'Esperando tareas de scraping...';
      let color = '#10b981'; // Emerald 500

      switch (status) {
        case 'Conectando...':
          title = 'Topo Túnel: Conectando';
          body = 'Estableciendo enlace seguro con el servidor...';
          color = '#f59e0b'; // Amber 500
          break;
        case 'Conectado':
          title = 'Topo Túnel: En Línea';
          body = 'WebSocket listo. Escuchando solicitudes...';
          color = '#10b981'; // Emerald 500
          break;
        case 'Procesando Tarea':
          title = 'Topo Túnel: Raspando';
          body = 'Procesando solicitud de MercadoLibre en curso...';
          color = '#3b82f6'; // Blue 500
          break;
        case 'Reconectando...':
          title = 'Topo Túnel: Reconectando';
          body = 'Conexión interrumpida. Reintentando enlace...';
          color = '#ef4444'; // Red 500
          break;
      }

      this.updateNotification(title, body, color);
    }
  }

  notifyMetrics() {
    if (this.onMetricsUpdate) {
      this.onMetricsUpdate(this.bytesSent, this.bytesReceived);
    }
  }
}

export default new WorkerService();
