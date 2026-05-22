import 'react-native-get-random-values';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, StatusBar, Animated, Easing } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';
import notifee, { EventType } from '@notifee/react-native';
import WorkerService from './src/services/WorkerService';
import { LinearGradient } from 'expo-linear-gradient';
import MlTunnelWebView from './src/components/MlTunnelWebView';

// Register foreground service task globally
notifee.registerForegroundService(() => {
  return new Promise(() => {
    // Promise never resolves to keep the service running in the background
  });
});

// Register background event handler for notification actions
notifee.onBackgroundEvent(async ({ type, detail }) => {
  const { pressAction } = detail;
  if (type === EventType.ACTION_PRESS && pressAction.id === 'stop-tunnel') {
    await WorkerService.stop();
  }
});

// Helper to format bytes
const formatBytes = (bytes) => {
  if (bytes === 0) return '0.0 Kb';
  const k = 1024;
  const sizes = ['Bytes', 'Kb', 'Mb', 'Gb'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// Helper to format time
const formatTime = (totalSeconds) => {
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
};

export default function App() {
  const [workerId, setWorkerId] = useState('');
  // isActive: controlado ÚNICAMENTE por el botón toggle (intención del usuario)
  // No se altera por reconexiones transitorias de Pusher.
  const [isActive, setIsActive] = useState(false);
  // connectionStatus: estado visible de la conexión (texto informativo)
  const [connectionStatus, setConnectionStatus] = useState('Desconectado');
  
  // WebView State
  const [webViewTask, setWebViewTask] = useState(null);
  const webViewCallbackRef = useRef(null);
  
  // Metrics
  const [secondsActive, setSecondsActive] = useState(0);
  const [bytesSent, setBytesSent] = useState(0);
  const [bytesReceived, setBytesReceived] = useState(0);
  
  // Animations
  const toggleAnim = useRef(new Animated.Value(0)).current; // 0 = Start (Top), 1 = Stop (Bottom)
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const pulseProcessingAnim = useRef(new Animated.Value(0)).current;

  const isProcessing = connectionStatus === 'Procesando Tarea';

  // Initialize WorkerService
  useEffect(() => {
    const initialize = async () => {
      let id = await AsyncStorage.getItem('worker_id');
      if (!id) {
        id = uuidv4();
        await AsyncStorage.setItem('worker_id', id);
      }
      setWorkerId(id);
      
      WorkerService.init(
        id,
        () => {}, // onTaskCompleted — no necesita manejar UI
        (newStatus) => {
          // Solo actualizar el texto de estado (subtítulo informativo).
          // NUNCA modificar isActive desde aquí para evitar que
          // reconexiones transitorias de Pusher reseteen la animación.
          setConnectionStatus(newStatus);
        },
        (sent, received) => {
          setBytesSent(sent);
          setBytesReceived(received);
        },
        (task, callback) => {
          // Permite que WorkerService delegue el render al hilo de UI
          setWebViewTask(task);
          webViewCallbackRef.current = callback;
        }
      );
    };
    initialize();

    // Register foreground event handler for notification actions
    const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.ACTION_PRESS && detail.pressAction.id === 'stop-tunnel') {
        WorkerService.stop();
      }
    });

    return () => {
      WorkerService.stop();
      unsubscribeForeground();
    };
  }, []);

  // Timer logic
  useEffect(() => {
    let interval = null;
    if (isActive) {
      interval = setInterval(() => {
        setSecondsActive(s => s + 1);
      }, 1000);
    } else {
      setSecondsActive(0);
    }
    return () => clearInterval(interval);
  }, [isActive]);

  // Toggle Animation logic
  useEffect(() => {
    Animated.timing(toggleAnim, {
      toValue: isActive ? 1 : 0,
      duration: 300,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();

    if (isActive) {
      Animated.loop(
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 2000,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        })
      ).start();
    } else {
      pulseAnim.setValue(0);
      pulseAnim.stopAnimation();
    }
  }, [isActive]);

  useEffect(() => {
    if (isProcessing) {
      Animated.loop(
        Animated.timing(pulseProcessingAnim, {
          toValue: 1,
          duration: 800, // Faster sci-fi pulse
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        })
      ).start();
    } else {
      pulseProcessingAnim.setValue(0);
      pulseProcessingAnim.stopAnimation();
    }
  }, [isProcessing]);

  const handleToggle = useCallback(async () => {
    if (isActive) {
      setIsActive(false); // intención inmediata del usuario → animación responde al instante
      await WorkerService.stop();
    } else {
      setIsActive(true);  // intención inmediata del usuario
      await WorkerService.start();
    }
  }, [isActive]);

  // Interpolations for Toggle Button Movement
  // Container height: 200, Button height: 80, Padding: 10
  // Travel distance = 200 - 80 - 20 = 100
  const translateY = toggleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 100],
  });

  // Background Gradient based on state
  const bgColors = isActive 
    ? ['#4a6f62', '#1b2d28', '#111816'] // Active VPN theme (Emerald/Military Green)
    : ['#2a2d36', '#1a1b21', '#101115']; // Inactive VPN theme (Dark Grey/Slate)

  return (
    <LinearGradient colors={bgColors} style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={bgColors[0]} />
      
      {/* Top Pill / Worker ID */}
      <View style={styles.topContainer}>
        <View style={styles.workerPill}>
          <Text style={styles.workerLabel}>ID de Worker: {workerId ? workerId.substring(0, 8) : '...'}</Text>
        </View>
      </View>

      {/* Hidden WebView Renderer */}
      {webViewTask && (
        <MlTunnelWebView 
          task={webViewTask}
          workerId={workerId}
          onResult={(resultPayload) => {
            if (webViewCallbackRef.current) {
              webViewCallbackRef.current(resultPayload);
            }
            // Desmontar completamente al terminar la tarea (no reutilizar instancias)
            setWebViewTask(null);
          }}
        />
      )}

      {/* Metrics Section */}
      <View style={styles.metricsContainer}>
        <Text style={styles.timerText}>{isActive ? formatTime(secondsActive) : '00:00:00'}</Text>
        <View style={styles.dataContainer}>
          <Text style={styles.dataText}>↓ {formatBytes(bytesReceived)}</Text>
          <Text style={styles.dataText}>↑ {formatBytes(bytesSent)}</Text>
        </View>
      </View>

      {/* Connection Status Section */}
      <View style={styles.statusContainer}>
        <Text style={styles.statusLocation}>Túnel Activo</Text>
        <Text style={styles.statusMainText}>{isActive ? 'Conectado' : 'Desconectado'}</Text>
        <Text style={styles.statusSubText}>{connectionStatus}</Text>
      </View>

      {/* Capsule Toggle Section */}
      <View style={styles.capsuleWrapper}>
        {isActive && !isProcessing && (
          <View style={styles.radarContainer}>
            <Animated.View style={[styles.radarCircle, { transform: [{ scale: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2] }) }], opacity: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }) }]} />
            <Animated.View style={[styles.radarCircle, { transform: [{ scale: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 2.5] }) }], opacity: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }) }]} />
            <Animated.View style={[styles.radarCircle, { transform: [{ scale: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 3] }) }], opacity: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0] }) }]} />
          </View>
        )}

        {isProcessing && (
          <View style={styles.radarContainer}>
            <Animated.View style={[styles.radarCircleProcessing, { transform: [{ scale: pulseProcessingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2] }) }], opacity: pulseProcessingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]} />
            <Animated.View style={[styles.radarCircleProcessing, { transform: [{ scale: pulseProcessingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 2.5] }) }], opacity: pulseProcessingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }) }]} />
            <Animated.View style={[styles.radarCircleProcessing, { transform: [{ scale: pulseProcessingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 3] }) }], opacity: pulseProcessingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] }) }]} />
          </View>
        )}

        <View style={styles.capsuleTrack}>
          {/* Top Indicator */}
          <View style={[styles.trackIndicator, { opacity: isActive ? 0 : 1 }]} />
          
          <Animated.View style={[styles.toggleButtonWrapper, { transform: [{ translateY }] }]}>
            <TouchableOpacity activeOpacity={0.9} onPress={handleToggle} style={styles.toggleButton}>
              <Text style={styles.toggleButtonText}>{isActive ? 'DETENER' : 'INICIAR'}</Text>
              <View style={[styles.powerIcon, { backgroundColor: isActive ? '#10b981' : '#ffffff' }]} />
            </TouchableOpacity>
          </Animated.View>

          {/* Bottom Indicator */}
          <View style={[styles.trackIndicator, styles.trackIndicatorBottom, { opacity: isActive ? 1 : 0 }]} />
        </View>
      </View>
      
      <View style={styles.bottomSpacer}>
        <Text style={styles.swipeText}>Toca el botón para {isActive ? 'Desconectar' : 'Conectar'}</Text>
        {/* isProcessing se deriva del connectionStatus (no de isActive) para el subtítulo */}
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    padding: 24,
    paddingTop: StatusBar.currentHeight ? StatusBar.currentHeight + 20 : 50,
  },
  topContainer: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 40,
  },
  workerPill: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  workerLabel: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  metricsContainer: {
    alignItems: 'center',
    marginBottom: 40,
    height: 100, // Fixed height to prevent layout jump
  },
  timerText: {
    fontSize: 52,
    fontWeight: 'bold',
    color: '#ffffff',
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  dataContainer: {
    flexDirection: 'row',
    marginTop: 10,
  },
  dataText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
    marginHorizontal: 12,
  },
  statusContainer: {
    alignItems: 'center',
    flex: 1,
  },
  statusLocation: {
    color: '#94a3b8',
    fontSize: 16,
    marginBottom: 8,
  },
  statusMainText: {
    color: '#ffffff',
    fontSize: 32,
    fontWeight: '700',
  },
  statusSubText: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 8,
    fontStyle: 'italic',
  },
  capsuleWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 250,
    width: '100%',
    position: 'relative',
  },
  radarContainer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    bottom: 25, // Align with the bottom button position
  },
  radarCircle: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 1,
    borderColor: '#10b981',
    borderStyle: 'dashed',
  },
  radarCircleProcessing: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: '#06b6d4', // Cyan 500
    borderStyle: 'solid',
    shadowColor: '#06b6d4',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
    elevation: 5,
  },
  capsuleTrack: {
    width: 90,
    height: 200,
    backgroundColor: 'rgba(20, 25, 30, 0.6)',
    borderRadius: 45,
    padding: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  trackIndicator: {
    width: 20,
    height: 4,
    backgroundColor: '#10b981',
    borderRadius: 2,
    position: 'absolute',
    top: 20,
  },
  trackIndicatorBottom: {
    top: undefined,
    bottom: 20,
  },
  toggleButtonWrapper: {
    width: 70,
    height: 80,
    zIndex: 10,
  },
  toggleButton: {
    width: '100%',
    height: '100%',
    backgroundColor: '#3b454e', // Inner button dark tone
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  toggleButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 8,
    letterSpacing: 1,
  },
  powerIcon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent', // The background color overrides this
  },
  bottomSpacer: {
    height: 60,
    justifyContent: 'flex-end',
  },
  swipeText: {
    color: '#64748b',
    fontSize: 12,
    letterSpacing: 1,
  }
});
