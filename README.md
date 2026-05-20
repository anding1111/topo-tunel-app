# Topo Túnel App (Saedi)

Aplicación móvil distribuida tipo **Worker** desarrollada en React Native y Expo. Actúa como un proxy de aplicación inversa para evadir bloqueos de IP de datacenters al realizar scraping de MercadoLibre utilizando conexiones móviles reales.

---

## 🚀 Características Clave

* **Diseño Ultra Minimalista:** Interfaz responsiva con modo oscuro premium, indicador visual de estado en tiempo real y contador de tareas.
* **Persistent Foreground Service:** Mantiene la app viva y el WebSocket conectado en segundo plano de forma ininterrumpida utilizando notificaciones de sistema persistentes con `@notifee/react-native`.
* **Claim-Lock Pattern:** Control distribuido de tareas para evitar colisiones entre múltiples workers móviles activos.
* **Consumo de Recursos Ultra Bajo:** Sin procesamiento de datos pesado (transmisión de HTML en crudo) y reconexión WebSocket con retroceso exponencial simple.

---

## 📁 Documentación del Proyecto

La documentación detallada se encuentra organizada en la carpeta `/docs`:

1. **[01 - Conexión WebSocket y Laravel en Hosting Compartido](docs/01-conexion-websocket-hosting.md):** 
   Estrategias de despliegue en hostings tradicionales (cPanel), limitaciones de puertos bloqueados, proxy reverso en Apache y estructura de payloads.
2. **[02 - Despliegue, Comandos y Compilación](docs/02-despliegue-y-compilacion.md):** 
   Comandos de desarrollo local, prerrequisitos nativos y cómo compilar la aplicación a producción (.APK) mediante EAS Build.
3. **[03 - Arquitectura y Flujo del Worker](docs/03-arquitectura-worker.md):** 
   Flujo paso a paso (diagrama de secuencia) del patrón de bloqueo de tareas, optimización de headers (User-Agent móvil) y seguridad del cliente.

---

## ⚡ Comandos Rápidos de Consola

### Iniciar Servidor de Desarrollo Metro:
```bash
npm run start
```

### Ejecutar Localmente en Dispositivos/Emuladores:
```bash
# Android
npm run android

# iOS (macOS)
npm run ios
```

### Compilar APK de Producción (Android):
```bash
eas build --platform android --profile preview
```

---

## ⚙️ Configuración del Entorno de Red (WebSocket)

El endpoint del WebSocket está configurado en `src/services/WorkerService.js`:
* **WebSocket URL:** `ws://topo.saedi.com.co:8080`
* **Canal:** `scraper-tasks`
* **Evento:** `NewScrapingTask`

Para entornos locales o de pruebas, edita la constante `WS_URL` y `API_BASE` dentro del servicio.
