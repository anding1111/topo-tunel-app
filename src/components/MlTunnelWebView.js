import React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';

const buildExtractorJs = (waitSelector, timeoutMs, minWaitMs) => `
  (function() {
    const start = Date.now();
    const selector = ${JSON.stringify(waitSelector)};
    const timeout = ${timeoutMs};
    const minWait = ${minWaitMs};

    function send(html, reason) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ html, reason, elapsed: Date.now() - start }));
    }
    function check() {
      const elapsed = Date.now() - start;
      const html = (document.documentElement && document.documentElement.outerHTML) ? document.documentElement.outerHTML : '';
      const isChallenge = html.includes('This page requires JavaScript') ||
                          html.includes('micro-landing') ||
                          html.includes('_bm_skipml') ||
                          html.includes('/anubis') ||
                          html.includes('account-verification') ||
                          html.includes('suspicious-traffic-frontend') ||
                          html.includes('challenge');

      // Respect min_wait_ms before starting to evaluate the selector
      if (elapsed < minWait) {
        setTimeout(check, 250);
        return;
      }

      if (document.querySelector(selector)) {
        if (isChallenge) {
          // If it matches the selector but still has challenge indications, wait
          setTimeout(check, 250);
          return;
        }
        send(html, 'selector_found');
        return;
      }
      if (elapsed > timeout) {
        send(html, 'timeout');
        return;
      }
      setTimeout(check, 250);
    }
    check();
    true;
  })();
`;

export default function MlTunnelWebView({ task, onResult }) {
  const webViewRef = React.useRef(null);
  
  if (!task || task.render_mode !== 'webview') return null;

  const runInjection = () => {
    const js = buildExtractorJs(task.wait_selector, task.wait_timeout_ms, task.min_wait_ms);
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(js);
    }
  };

  return (
    <View style={{ width: 0, height: 0, opacity: 0 }} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ uri: task.url }}
        userAgent={task.user_agent}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        injectedJavaScript={buildExtractorJs(task.wait_selector, task.wait_timeout_ms, task.min_wait_ms)}
        onLoadEnd={runInjection}
        onMessage={(e) => {
          try {
            const payload = JSON.parse(e.nativeEvent.data);
            console.log(`WebView completed task ${task.task_id} with reason: ${payload.reason}`);
            onResult(payload.html); 
          } catch (err) {
            console.error('Error parsing WebView message:', err);
            onResult(null); // Return null on parsing failure to let Worker release it
          }
        }}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.warn('WebView error: ', nativeEvent);
          onResult(null); // On failure, return null so Worker handles failure
        }}
      />
    </View>
  );
}
