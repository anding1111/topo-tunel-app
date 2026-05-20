# 01 - Conexión WebSocket en Hosting Compartido (Laravel)

Este documento detalla cómo establecer y mantener la conexión por WebSockets de la aplicación móvil con un backend Laravel alojado en un **hosting compartido**, considerando las restricciones típicas de este entorno.

---

## 1. El Desafío del Hosting Compartido

En un servidor de hosting compartido estándar (por ejemplo, administrado con cPanel), nos enfrentamos a dos limitaciones críticas:
1. **Bloqueo de Puertos:** Los firewalls del proveedor suelen bloquear puertos personalizados (como el `:8080` especificado en el entorno de desarrollo). Solo permiten tráfico en los puertos estándar HTTP (`80`) y HTTPS (`443`).
2. **Procesos de Larga Duración (Daemons):** Los hostings compartidos limitan el uso de CPU y memoria, matando procesos CLI persistentes como `php artisan websockets:serve` o `node server.js` después de unos minutos.

---

## 2. Estrategias de Conexión Recomendadas

A continuación se presentan las soluciones viables, ordenadas de mayor a menor recomendación técnica.

### Opción A: Migrar WebSocket a Pusher Channels (Altamente Recomendado)
En lugar de auto-alojar el servidor de WebSocket en el hosting compartido, se delega a Pusher.
* **Por qué:** Pusher opera sobre HTTPS estándar (`443`), eliminando problemas de firewalls. Es estable, no consume recursos del hosting compartido y su plan gratuito soporta hasta 200,000 mensajes diarios y 100 conexiones simultáneas (suficiente para este sistema de workers).
* **Configuración en Laravel (`.env`):**
  ```env
  BROADCAST_DRIVER=pusher
  PUSHER_APP_ID=tu_app_id
  PUSHER_APP_KEY=tu_app_key
  PUSHER_APP_SECRET=tu_app_secret
  PUSHER_APP_CLUSTER=us2
  ```
* **Adaptación en la App Movil:**
  Modificar el WebSocket nativo para apuntar a la URL pública de Pusher o usar la librería `pusher-js`.

### Opción B: Servidor WebSocket Externo en VPS (Recomendado)
Mantener el backend de Laravel (API, Web, BD) en el hosting compartido, pero levantar el servidor WebSocket (Soketi o Laravel WebSockets) en un servidor VPS económico (ej. AWS Lightsail o DigitalOcean de $4-5 USD).
* **Por qué:** El VPS permite abrir el puerto `:8080` (o redirigir al puerto `:443` con SSL mediante Nginx) y ejecutar procesos persistentes con `Supervisor`.
* **Configuración en Laravel (`.env`):**
  ```env
  BROADCAST_DRIVER=pusher
  PUSHER_HOST=websocket.saedi.com.co (IP o subdominio apuntando al VPS)
  PUSHER_PORT=443
  PUSHER_SCHEME=https
  ```

### Opción C: Ejecución en Hosting Compartido vía Proxy Reverso de Nginx/Apache
Si obligatoriamente se debe ejecutar todo en el hosting compartido, se debe saltar el bloqueo de puertos utilizando el puerto estándar `443` mediante un proxy reverso.

1. **Levantar el Servicio Websocket en cPanel:**
   Crea una "Node.js App" desde cPanel. Esto permite ejecutar un script Node de forma persistente (usaremos un WebSocket server en Node.js que escuche internamente, ej. en `127.0.0.1:8080`). El sistema de cPanel (a través de Phusion Passenger) mantendrá vivo el proceso.
   
2. **Configuración de Apache / `.htaccess` para Proxy Reverso:**
   Dado que el puerto `8080` está bloqueado externamente, redirigimos el tráfico de un subdominio específico (ej. `ws.saedi.com.co`) en el puerto `443` hacia el puerto local interno `8080`:

   ```apache
   RewriteEngine On
   # Si la petición es Websocket, la redirige internamente
   RewriteCond %{HTTP:Upgrade} =websocket [NC]
   RewriteCond %{HTTP:Connection} upgrade [NC]
   RewriteRule ^(.*)$ http://127.0.0.1:8080/$1 [P,L]
   ```

---

## 3. Protocolo de Comunicación (Estructura de Mensajes)

La aplicación móvil espera recibir tramas JSON a través del WebSocket. El backend debe emitir eventos en el siguiente formato para que el worker los procese de inmediato:

### Payload de Evento Esperado (`NewScrapingTask`):
```json
{
  "event": "NewScrapingTask",
  "channel": "scraper-tasks",
  "data": {
    "task_id": 1045,
    "url": "https://articulo.mercadolibre.com.co/MCO-123456-producto-ejemplo"
  }
}
```

* **Nota:** Si la infraestructura de Laravel usa un cliente WebSocket plano en lugar del protocolo Pusher, la app móvil también tiene compatibilidad para procesar payloads planos simplificados:
```json
{
  "task_id": 1045,
  "url": "https://articulo.mercadolibre.com.co/MCO-123456-producto-ejemplo"
}
```
