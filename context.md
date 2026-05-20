# Contexto del Proyecto: Topo Túnel App (Saedi)

## 1. Visión General
"Topo Túnel" es un worker móvil distribuido construido con React Native y Expo. Su única función es actuar como un proxy inverso de aplicación: se conecta por WebSockets al backend de Laravel de "topo.saedi.com.co", recibe URLs de MercadoLibre, las descarga usando la conexión de datos móviles del teléfono (para evadir bloqueos de IP de datacenter) y devuelve el HTML crudo al backend.

## 2. Arquitectura y Flujo (Claim-Lock Pattern)
El sistema maneja concurrencia (múltiples teléfonos conectados) mediante un patrón de bloqueo.
1. **Escucha:** La app mantiene una conexión abierta por WebSocket a `ws://topo.saedi.com.co:8080`.
2. **Recepción:** Llega un evento `NewScrapingTask` con un `task_id` y `url`.
3. **Claim (Reclamación):** La app hace un POST rápido a la API para reclamar la tarea usando su ID único de dispositivo (`worker_id`).
4. **Scraping:** Si el Claim es exitoso (`success: true`), la app hace un `fetch()` a la URL de MercadoLibre.
5. **Callback:** La app envía el HTML resultante al backend y vuelve al estado de escucha.

## 3. Endpoints del Backend
* **WebSocket:** `ws://topo.saedi.com.co:8080` (Canal: `scraper-tasks`, Evento: `NewScrapingTask`)
* **API Claim:** `POST https://topo.saedi.com.co/api/v1/scraper/claim`
  * Payload: `{ "task_id": 123, "worker_id": "device-uuid-1234" }`
  * Respuesta esperada: `{ "success": true/false }`
* **API Callback:** `POST https://topo.saedi.com.co/api/v1/scraper/callback`
  * Payload: `{ "task_id": 123, "html": "<html>...</html>" }`

## 4. Requerimientos de Rendimiento y UI
* **Extremo Minimalismo:** La UI solo debe tener un logo/título, el `worker_id` generado aleatoriamente en el primer inicio, estadísticas (tareas procesadas hoy) y un botón grande de "Conectar/Desconectar".
* **Segundo Plano (Foreground Service):** Al minimizar la app, debe registrar un servicio de primer plano (Foreground Service en Android) con una notificación persistente, silenciosa y muy sutil (Ej: "Topo Túnel: Escuchando tareas..."). Esto evita que el OS mate la conexión WebSocket para ahorrar batería.
* **Eficiencia:** Sin animaciones pesadas. Reducir los re-renders al mínimo. No parsear el HTML en el móvil, solo transmitirlo crudo.