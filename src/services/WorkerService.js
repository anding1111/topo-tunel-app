import axios from 'axios';
import notifee, { AndroidImportance } from '@notifee/react-native';

const WS_URL = 'ws://topo.saedi.com.co:8080';
const API_BASE = 'https://topo.saedi.com.co/api/v1/scraper';

// Use a realistic mobile user agent
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

class WorkerService {
  constructor() {
    this.ws = null;
    this.workerId = null;
    this.isActive = false;
    this.onTaskCompleted = null;
    this.onStatusChange = null;
    this.reconnectTimeout = null;
  }

  init(workerId, onTaskCompleted, onStatusChange) {
    this.workerId = workerId;
    this.onTaskCompleted = onTaskCompleted;
    this.onStatusChange = onStatusChange;
  }

  async start() {
    if (this.isActive) return;
    this.isActive = true;
    
    // Start Foreground Service
    await this.startForegroundService();

    this.connectWebSocket();
    this.notifyStatus('Conectando...');
  }

  async stop() {
    this.isActive = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    await this.stopForegroundService();
    this.notifyStatus('Desconectado');
  }

  async startForegroundService() {
    try {
      // Create a channel (required for Android)
      const channelId = await notifee.createChannel({
        id: 'tunnel-service',
        name: 'Topo Túnel Service',
        importance: AndroidImportance.LOW,
      });

      // Display the notification
      await notifee.displayNotification({
        title: 'Topo Túnel',
        body: 'Activo y esperando tareas...',
        android: {
          channelId,
          asForegroundService: true,
          ongoing: true,
        },
      });
    } catch (e) {
      console.error('Error starting foreground service:', e);
    }
  }

  async stopForegroundService() {
    try {
      await notifee.stopForegroundService();
    } catch (e) {
      console.error('Error stopping foreground service:', e);
    }
  }

  connectWebSocket() {
    if (!this.isActive) return;
    
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      this.notifyStatus('Conectado');
      console.log('WebSocket Connected');
      
      // If it's Pusher/Laravel Websockets, we might need to subscribe
      const subscribeMsg = JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: 'scraper-tasks' }
      });
      this.ws.send(subscribeMsg);
    };

    this.ws.onmessage = async (e) => {
      try {
        const message = JSON.parse(e.data);
        
        // Handle Laravel Echo / Pusher format
        if (message.event === 'NewScrapingTask') {
          let taskData = message.data;
          if (typeof taskData === 'string') {
            taskData = JSON.parse(taskData);
          }
          await this.processTask(taskData);
        } else if (message.task_id && message.url) {
          // Handle Raw format
          await this.processTask(message);
        }
      } catch (error) {
        // Ignorar mensajes no JSON o keep-alives
      }
    };

    this.ws.onclose = (e) => {
      console.log('WebSocket Disconnected', e.reason);
      if (this.isActive) {
        this.notifyStatus('Reconectando...');
        this.reconnectTimeout = setTimeout(() => this.connectWebSocket(), 3000);
      }
    };

    this.ws.onerror = (e) => {
      console.log('WebSocket Error', e.message);
      this.ws.close();
    };
  }

  async processTask(task) {
    if (!task || !task.task_id || !task.url) return;
    
    console.log(`Received task: ${task.task_id}`);
    this.notifyStatus('Procesando Tarea');

    try {
      // 1. Claim the task
      const claimRes = await axios.post(`${API_BASE}/claim`, {
        task_id: task.task_id,
        worker_id: this.workerId,
      });

      if (!claimRes.data || !claimRes.data.success) {
        console.log(`Task ${task.task_id} claimed by another worker.`);
        this.notifyStatus('Conectado');
        return; // Ignore silently
      }

      console.log(`Task ${task.task_id} successfully claimed. Scraping...`);

      // 2. Scrape the URL
      const scrapeRes = await axios.get(task.url, {
        headers: {
          'User-Agent': MOBILE_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
        },
        timeout: 15000, // 15 seconds timeout
      });

      const html = scrapeRes.data;

      // 3. Callback with the HTML
      await axios.post(`${API_BASE}/callback`, {
        task_id: task.task_id,
        html: html,
      });

      console.log(`Task ${task.task_id} completed successfully.`);
      
      if (this.onTaskCompleted) {
        this.onTaskCompleted();
      }

    } catch (error) {
      console.error(`Error processing task ${task.task_id}:`, error.message);
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
  }
}

export default new WorkerService();
