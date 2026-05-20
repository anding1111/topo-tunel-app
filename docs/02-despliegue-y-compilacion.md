# 02 - Despliegue, Comandos y Compilación Novedosa

Este documento detalla la hoja de ruta exacta y los comandos necesarios para desarrollar de forma local, realizar pruebas con hardware real y compilar la aplicación "Topo Túnel" utilizando flujos nativos optimizados.

---

## 1. Comandos de Desarrollo Local Rápido

Para correr el servidor Metro local y emparejar con el empaquetador JS:
```bash
npm run start
```

---

## 2. 🛠️ Compilación Nativa Local (Android)

Dado que la aplicación inyecta librerías como `@notifee/react-native` que requieren enlazar código nativo Java/Kotlin para soportar **Foreground Services**, **Expo Go no es compatible para pruebas en segundo plano**. Es obligatorio compilar un cliente de desarrollo directamente en el dispositivo físico.

### Prerrequisitos:
* Teléfono físico Android conectado por USB al computador.
* **Depuración USB (USB Debugging)** activada y aceptada en la pantalla del móvil.
* Android SDK y variables de entorno configuradas localmente (`ANDROID_HOME`).

### Flujo de Compilación Paso a Paso:

#### **Paso 1: Verificación de Módulos y Árbol de Dependencias**
Antes de generar archivos nativos, nos aseguramos de que el árbol de dependencias de npm esté correctamente instalado y validado:
```bash
npm install
```

#### **Paso 2: Generación del Código Nativo Limpio (Prebuild)**
Este comando lee la estructura de `app.json`, inyecta dinámicamente los plugins de Notifee y genera la carpeta `android` limpia y lista para compilar:
```bash
npx expo prebuild --clean --platform android
```

#### **Paso 3: Compilación y Despliegue en Dispositivo (Run)**
Este comando inicia el demonio de Metro (empaquetador de JS) y lanza la suite Gradle para compilar el APK de desarrollo e instalarlo automáticamente en tu teléfono conectado:
```bash
npx expo run:android
```

---

## 3. ⚠️ Notas Críticas para la Fase de Desarrollo Novedoso

* **Tiempo de Espera Inicial:** El primer comando `npx expo run:android` tardará bastantes minutos. Gradle descargará el núcleo de React Native, las dependencias de AndroidX necesarias y compilará la base de la app desde cero. Los siguientes comandos compilarán en cuestión de segundos gracias a la caché nativa.
* **Permisos de Notificaciones (Android 13+):** A partir de Android 13, los permisos de notificaciones deben ser solicitados de forma explícita. Notifee requiere este permiso para poder anclar el servicio en primer plano. Cuando la app se abra en el dispositivo, asegúrate de otorgar el permiso si el sistema lo solicita.
* **Metro Bundler Activo:** La terminal de desarrollo se quedará corriendo el servidor de Metro. Si cierras esa terminal, la app en tu teléfono dejará de funcionar en modo de desarrollo (hasta que hagamos el APK final de producción).

---

## 4. Compilación para Distribución / Producción (EAS Build)

Cuando el flujo local esté verificado y desees generar el instalador APK standalone que no requiera el cable USB ni Metro:

### Instalar EAS CLI y Autenticar:
```bash
npm install -g eas-cli
eas login
```

### Configurar perfil en `eas.json` (Añadir perfil preview para generar APK):
```json
{
  "cli": {
    "version": ">= 10.0.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "production": {}
  }
}
```

### Ejecutar compilación remota de APK:
```bash
eas build --platform android --profile preview
```
