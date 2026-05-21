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
    this.reconnectTimeout = null;
    this.bytesSent = 0;
    this.bytesReceived = 0;

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

  init(workerId, onTaskCompleted, onStatusChange, onMetricsUpdate) {
    this.workerId = workerId;
    this.onTaskCompleted = onTaskCompleted;
    this.onStatusChange = onStatusChange;
    this.onMetricsUpdate = onMetricsUpdate;
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

  async processTask(task) {
    if (!task || !task.task_id || !task.url) return;
    
    console.log(`Received task: ${task.task_id}`);
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
        console.log(`Claim failed for task ${task.task_id}:`, err.message);
        this.notifyStatus('Conectado');
        return; // Ignore silently (409 Conflict o similar)
      }

      if (!claimRes.data || !claimRes.data.success) {
        console.log(`Task ${task.task_id} claimed by another worker.`);
        this.notifyStatus('Conectado');
        return;
      }

      console.log(`Task ${task.task_id} successfully claimed. Scraping...`);

      // 2. Scrape the URL
      let html;
      try {
        const scrapeRes = await axios.get(task.url, {
          headers: {
            'User-Agent': MOBILE_USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
          },
          timeout: 15000, // 15 seconds timeout
        });
        html = scrapeRes.data;
      } catch (scrapeErr) {
        console.log(`Scraping failed for task ${task.task_id}:`, scrapeErr.message);
        
        // 2b. Release the task so other workers can retry
        try {
          await axios.post(`${API_BASE}/release`, {
            task_id: task.task_id,
            worker_id: this.workerId,
          });
          console.log(`Task ${task.task_id} successfully released.`);
        } catch (releaseErr) {
          console.error(`Error releasing task ${task.task_id}:`, releaseErr.message);
        }
        return;
      }

      // 3. Callback with the HTML
      await axios.post(`${API_BASE}/callback`, {
        task_id: task.task_id,
        worker_id: this.workerId,
        html: html,
      });

      console.log(`Task ${task.task_id} completed successfully.`);
      
      if (this.onTaskCompleted) {
        this.onTaskCompleted();
      }

    } catch (error) {
      console.error(`Error in processTask for ${task.task_id}:`, error.message);
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
