import 'react-native-get-random-values';
import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, StatusBar, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';
import notifee, { EventType } from '@notifee/react-native';
import WorkerService from './src/services/WorkerService';

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

export default function App() {
  const [workerId, setWorkerId] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState('Desconectado');
  const [tasksCompleted, setTasksCompleted] = useState(0);

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
        () => setTasksCompleted(prev => prev + 1),
        (newStatus) => {
          setStatus(newStatus);
          if (newStatus === 'Desconectado') {
            setIsActive(false);
          } else {
            setIsActive(true);
          }
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

  const toggleTunnel = useCallback(async () => {
    if (isActive) {
      await WorkerService.stop();
    } else {
      await WorkerService.start();
    }
  }, [isActive]);

  const getStatusColor = (currentStatus) => {
    switch(currentStatus) {
      case 'Conectado': return '#10b981'; // Emerald 500
      case 'Procesando Tarea': return '#3b82f6'; // Blue 500
      case 'Conectando...':
      case 'Reconectando...': return '#f59e0b'; // Amber 500
      default: return '#ef4444'; // Red 500
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      
      <View style={styles.header}>
        <Text style={styles.title}>Topo Túnel</Text>
        <Text style={styles.subtitle}>Worker Distribuido</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.statusContainer}>
          <View style={[styles.statusDot, { backgroundColor: getStatusColor(status) }]} />
          <Text style={styles.statusText}>{status}</Text>
        </View>

        {status === 'Procesando Tarea' && (
          <ActivityIndicator size="small" color="#3b82f6" style={styles.loader} />
        )}

        <View style={styles.statsContainer}>
          <Text style={styles.statsLabel}>Tareas Completadas</Text>
          <Text style={styles.statsValue}>{tasksCompleted}</Text>
        </View>

        <View style={styles.idContainer}>
          <Text style={styles.idLabel}>Worker ID</Text>
          <Text style={styles.idValue} selectable>{workerId || 'Cargando...'}</Text>
        </View>
      </View>

      <TouchableOpacity 
        style={[styles.button, isActive ? styles.buttonActive : styles.buttonInactive]} 
        onPress={toggleTunnel}
        activeOpacity={0.8}
      >
        <Text style={styles.buttonText}>{isActive ? 'DESACTIVAR TÚNEL' : 'ACTIVAR TÚNEL'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000', // Pure Black
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    paddingTop: StatusBar.currentHeight ? StatusBar.currentHeight + 24 : 40,
  },
  header: {
    marginBottom: 48,
    alignItems: 'center',
  },
  title: {
    fontSize: 42,
    fontWeight: 'bold',
    color: '#f8fafc', // Slate 50
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b', // Slate 500
    marginTop: 8,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: '#0d0d0d', // OLED Dark Gray
    borderRadius: 24,
    padding: 32,
    width: '100%',
    alignItems: 'center',
    marginBottom: 48,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
    borderWidth: 1,
    borderColor: '#1e293b', // Slate 800 subtle border
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  statusDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginRight: 12,
  },
  statusText: {
    fontSize: 22,
    color: '#f8fafc',
    fontWeight: '600',
  },
  loader: {
    marginBottom: 24,
  },
  statsContainer: {
    alignItems: 'center',
    marginBottom: 24,
    paddingBottom: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b', // Slate 800 subtle line
    width: '100%',
  },
  statsLabel: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  statsValue: {
    fontSize: 64,
    fontWeight: 'bold',
    color: '#10b981', // Emerald 500
  },
  idContainer: {
    alignItems: 'center',
    width: '100%',
  },
  idLabel: {
    fontSize: 12,
    color: '#475569', // Slate 600
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  idValue: {
    fontSize: 12,
    color: '#64748b',
    fontFamily: 'monospace',
  },
  button: {
    width: '100%',
    height: 64,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  buttonInactive: {
    backgroundColor: '#2563eb', // Blue 600
  },
  buttonActive: {
    backgroundColor: '#dc2626', // Red 600
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
});
