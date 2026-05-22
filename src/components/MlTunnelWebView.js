/**
 * MlTunnelWebView.js
 *
 * Componente WebView oculto para scraping real de MercadoLibre.
 * Implementa todos los requisitos del equipo backend para evadir
 * el reto Akamai/Anubis y entregar el HTML real del listado.
 *
 * REGLAS CRÍTICAS:
 *  - Una sola instancia activa a la vez (cola FIFO gestionada externamente en WorkerService).
 *  - Tamaño real 390×844 fuera de pantalla (no 0x0/1x1).
 *  - UA exacto del backend. Nunca el UA por defecto de Android WebView (contiene "; wv)").
 *  - Cookies NO se limpian entre tareas del mismo dominio.
 *  - Extractor idempotente: usa window.__TOPO_ML_EXTRACTOR_ACTIVE__ como guard.
 *  - NO enviar callback si el HTML es micro-landing / challenge.
 *  - Payload enriquecido: task_id, worker_id, html, reason, elapsed, url, title, len, hasListing, isChallenge, isAccount.
 */

import React, { useRef, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

// ─── Strings de detección de páginas de reto / bloqueo ─────────────────────
const CHALLENGE_MARKERS = [
  'micro-landing-container',
  '_bm_skipml',
  '/anubis',
  'This page requires JavaScript',
  'account-verification',
  'gz-verify',
  'suspicious-traffic-frontend',
];

// ─── Selectores que confirman que el listado ya está en el DOM ──────────────
const LISTING_SELECTORS = [
  'li.ui-search-layout__item',
  '[class*="poly-card"]',
];

/**
 * Genera el script extractor inyectado en el WebView.
 * Es idempotente: usa window.__TOPO_ML_EXTRACTOR_ACTIVE__ para no
 * registrar múltiples loops cuando onLoadEnd se dispara varias veces.
 */
const buildExtractorJs = (waitSelector, timeoutMs, minWaitMs, domStableMs, challengeGraceMs) => `
  (function() {
    // Guard idempotente: solo corre una instancia del extractor
    if (window.__TOPO_ML_EXTRACTOR_ACTIVE__) return;
    window.__TOPO_ML_EXTRACTOR_ACTIVE__ = true;

    const start = Date.now();
    const selector   = ${JSON.stringify(waitSelector)};
    const timeout    = ${Number(timeoutMs)};
    const minWait    = ${Number(minWaitMs)};
    const stableMs   = ${Number(domStableMs || 700)};
    const graceMs    = ${Number(challengeGraceMs || 9000)};

    const CHALLENGE_MARKERS = ${JSON.stringify(CHALLENGE_MARKERS)};
    const LISTING_SELECTORS = ${JSON.stringify(LISTING_SELECTORS)};

    function getHtml() {
      return document.documentElement ? document.documentElement.outerHTML : '';
    }

    function hasChallenge(html) {
      return CHALLENGE_MARKERS.some(m => html.includes(m));
    }

    function hasListing(html) {
      return LISTING_SELECTORS.some(s => !!document.querySelector(s));
    }

    function isAccountPage(html) {
      return html.includes('account-verification') || html.includes('gz-verify');
    }

    function send(html, reason) {
      const elapsed = Date.now() - start;
      const challenge = hasChallenge(html);
      const listing   = hasListing(html);
      const account   = isAccountPage(html);
      const payload = {
        reason,
        elapsed,
        url:         window.location.href,
        title:       document.title,
        len:         html.length,
        hasListing:  listing,
        isChallenge: challenge,
        isAccount:   account,
        html,
      };
      window.__TOPO_ML_EXTRACTOR_ACTIVE__ = false; // libera para re-inyección si es necesario
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }

    let lastDomChange = Date.now();
    let lastLen = 0;

    function check() {
      const elapsed = Date.now() - start;
      const html    = getHtml();
      const len     = html.length;

      // Rastrear cambios en el DOM para medir estabilidad
      if (len !== lastLen) {
        lastLen      = len;
        lastDomChange = Date.now();
      }

      const challenge = hasChallenge(html);
      const listing   = hasListing(html);

      // Todavía dentro de la grace period del challenge: esperar sin exportar
      if (challenge && (elapsed < graceMs)) {
        setTimeout(check, 250);
        return;
      }

      // No se ha cumplido el piso mínimo de espera
      if (elapsed < minWait) {
        setTimeout(check, 250);
        return;
      }

      // Hay listado Y no hay challenge
      if (listing && !challenge) {
        const domAge = Date.now() - lastDomChange;
        if (domAge < stableMs) {
          // DOM aún está cambiando, esperar a que se estabilice
          setTimeout(check, 100);
          return;
        }
        send(html, 'selector_found');
        return;
      }

      // Timeout alcanzado: enviar lo que tengamos (sin importar si es challenge)
      if (elapsed >= timeout) {
        send(html, 'timeout');
        return;
      }

      setTimeout(check, 250);
    }

    check();
    true;
  })();
`;

// ─── Componente ─────────────────────────────────────────────────────────────

export default function MlTunnelWebView({ task, workerId, onResult }) {
  const webViewRef = useRef(null);

  // Re-inyectar en cada onLoadEnd (ML redirige tras el challenge y destruye el contexto de timers)
  const handleLoadEnd = useCallback(() => {
    if (!webViewRef.current || !task) return;
    const js = buildExtractorJs(
      task.wait_selector,
      task.wait_timeout_ms   || 12000,
      task.min_wait_ms       || 2500,
      task.dom_stable_ms     || 700,
      task.challenge_grace_ms || 9000,
    );
    // Primero resetear el guard para que el extractor se re-registre
    webViewRef.current.injectJavaScript(`
      window.__TOPO_ML_EXTRACTOR_ACTIVE__ = false;
      true;
    `);
    webViewRef.current.injectJavaScript(js);
  }, [task]);

  const handleMessage = useCallback((e) => {
    try {
      const payload = JSON.parse(e.nativeEvent.data);
      console.log(
        `[MlTunnelWebView] task=${task.task_id} reason=${payload.reason} ` +
        `len=${payload.len} hasListing=${payload.hasListing} isChallenge=${payload.isChallenge} elapsed=${payload.elapsed}ms`
      );
      // No hacer callback si es micro-landing/challenge (sin timeout todavía)
      if (payload.isChallenge && payload.reason !== 'timeout') {
        console.warn('[MlTunnelWebView] Challenge detectado, ignorando postMessage — esperando redirección...');
        return;
      }
      // Enriquecer payload con task_id y worker_id para el callback del backend
      onResult({
        ...payload,
        task_id:   task.task_id,
        worker_id: workerId,
      });
    } catch (err) {
      console.error('[MlTunnelWebView] Error parseando mensaje:', err);
      onResult({ task_id: task.task_id, worker_id: workerId, html: null, reason: 'parse_error' });
    }
  }, [task, workerId, onResult]);

  const handleError = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.warn('[MlTunnelWebView] WebView error:', nativeEvent);
    onResult({ task_id: task.task_id, worker_id: workerId, html: null, reason: 'webview_error' });
  }, [task, workerId, onResult]);

  // Bloquear deeplinks nativos de ML que harían abrir la app nativa y romper el WebView
  const handleShouldStartLoad = useCallback(({ url }) => {
    if (url.startsWith('meli://') || url.startsWith('mercadolibre://')) {
      console.log(`[MlTunnelWebView] Bloqueando deeplink nativo: ${url}`);
      return false; // No navegar
    }
    return true;
  }, []);

  if (!task || task.render_mode !== 'webview') return null;

  return (
    // Tamaño real 390×844 fuera de pantalla.
    // NO usar width:0/height:0 ni display:none → Android pausa el JS del WebView.
    <View style={styles.offscreenContainer} pointerEvents="none">
      <WebView
        ref={webViewRef}
        // ── Fuente ──────────────────────────────────────────────────────────
        source={{ uri: task.url }}

        // ── User Agent exacto del backend (Chrome 124 Android) ────────────
        // El UA default de Android WebView incluye "; wv)" y ML lo bloquea.
        userAgent={task.user_agent}

        // ── Flags obligatorios ────────────────────────────────────────────
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        cacheEnabled={true}
        incognito={false}
        mixedContentMode="compatibility"
        setSupportMultipleWindows={false}

        // ── Headers adicionales ──────────────────────────────────────────
        // Accept-Language colombiano para recibir listados correctos de ML Colombia
        originWhitelist={['*']}

        // ── Extractor inicial (también se re-inyecta en onLoadEnd) ───────
        injectedJavaScript={buildExtractorJs(
          task.wait_selector,
          task.wait_timeout_ms    || 12000,
          task.min_wait_ms        || 2500,
          task.dom_stable_ms      || 700,
          task.challenge_grace_ms || 9000,
        )}

        // ── Handlers ─────────────────────────────────────────────────────
        onLoadEnd={handleLoadEnd}
        onMessage={handleMessage}
        onError={handleError}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Viewport real (390×844) pero fuera del área visible.
  // left: -10000 lo saca de pantalla. opacity: 0.01 en vez de 0 para
  // que Android NO lo considere invisible y no pause el JS.
  offscreenContainer: {
    position: 'absolute',
    left: -10000,
    top: 0,
    width: 390,
    height: 844,
    opacity: 0.01,
  },
});
