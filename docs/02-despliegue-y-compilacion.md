# 02 - Despliegue y Compilación de la Aplicación

Este documento detalla los comandos necesarios para desarrollar de forma local, realizar pruebas y compilar la aplicación "Topo Túnel" para producción.

---

## 1. Comandos de Desarrollo Local

Para correr el proyecto localmente en un simulador o en un dispositivo físico con Expo Go / Expo Dev Client:

### Iniciar servidor de desarrollo Metro:
```bash
npm run start
```

### Iniciar directamente en plataformas específicas:
```bash
# Android
npm run android

# iOS (Requiere macOS)
npm run ios
```

---

## 2. Requisitos de Compilación (Native Code)

Dado que la aplicación implementa `@notifee/react-native` para mantener un **Foreground Service** persistente en segundo plano, **no se puede probar directamente con la app genérica de Expo Go** para producción. Es necesario realizar una compilación nativa (Dev Client o Build de Producción).

### Requisitos en Android:
* La aplicación solicitará automáticamente el permiso `FOREGROUND_SERVICE` y `POST_NOTIFICATIONS` al instalarse/ejecutarse.
* La configuración en `app.json` ya incluye el plugin de configuración para inyectar estos permisos nativos en el `AndroidManifest.xml` durante el prebuild.

---

## 3. Compilación para Producción (EAS Build)

La vía recomendada para generar el instalador de Android (`.apk` o `.aab`) es utilizando **EAS Build** (Expo Application Services).

### Paso 1: Instalar la CLI de EAS globalmente
```bash
npm install -g eas-cli
```

### Paso 2: Iniciar sesión en tu cuenta de Expo
```bash
eas login
```

### Paso 3: Configurar el proyecto de EAS
Ejecuta el siguiente comando en la raíz del proyecto para generar el archivo de configuración `eas.json`:
```bash
eas build:configure
```

### Paso 4: Generar el APK de producción (Android)
Para distribuir y probar el archivo de forma directa en los celulares de los operadores/workers, se recomienda configurar un perfil que exporte un archivo `.apk` (en lugar del `.aab` predeterminado de la Play Store).

Agrega o edita la sección `build` en tu `eas.json` recién generado:
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
  },
  "submit": {
    "production": {}
  }
}
```

Luego ejecuta el comando para construir la compilación preview (APK):
```bash
# Generar APK descargable de forma directa
eas build --platform android --profile preview
```

### Paso 5: Generar compilación local (Alternativa sin EAS)
Si tienes Android Studio configurado localmente y deseas compilar localmente:
```bash
# Genera las carpetas nativas /android
npx expo prebuild

# Compila y ejecuta la aplicación nativa en tu dispositivo conectado
npx expo run:android --variant release
```
