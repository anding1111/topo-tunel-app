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
      if (document.querySelector(selector)) {
        const remaining = Math.max(0, minWait - (Date.now() - start));
        setTimeout(() => send(document.documentElement.outerHTML, 'selector_found'), remaining);
        return;
      }
      if (Date.now() - start > timeout) {
        send(document.documentElement.outerHTML, 'timeout');
        return;
      }
      setTimeout(check, 250);
    }
    check();
    true;
  })();
`;

export default function MlTunnelWebView({ task, onResult }) {
  if (!task || task.render_mode !== 'webview') return null;

  return (
    <View style={{ width: 0, height: 0, opacity: 0 }} pointerEvents="none">
      <WebView
        source={{ uri: task.url }}
        userAgent={task.user_agent}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        injectedJavaScript={buildExtractorJs(task.wait_selector, task.wait_timeout_ms, task.min_wait_ms)}
        onMessage={(e) => {
          try {
            const payload = JSON.parse(e.nativeEvent.data);
            console.log(\`WebView completed task \${task.task_id} with reason: \${payload.reason}\`);
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
