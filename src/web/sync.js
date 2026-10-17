// Authenticated SSE with one owned connection, cancellable retries, and no message submission on reconnect.
function watchFeed({ path, api, beforeConnect, onEvent, onDisconnect }) {
  let stopped = false, generation = 0, controller, timer, delay = 500;
  async function connect() {
    const own = ++generation;
    controller?.abort(); clearTimeout(timer);
    const abort = controller = new AbortController();
    let reader;
    try {
      await beforeConnect?.(abort.signal);
      if (stopped || own !== generation) return;
      const response = await api(path, { signal: abort.signal, headers: { accept: "text/event-stream" }, cache: "no-store" });
      if (!response.ok) throw Object.assign(new Error((await response.json().catch(() => ({}))).error || response.statusText), { status: response.status });
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "";
      while (!stopped && own === generation) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Connection closed");
        buffer += decoder.decode(value, { stream: true });
        // Normalize after buffering: a CRLF sequence can cross network chunks.
        buffer = buffer.replace(/\r\n/g, "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = frame.match(/^event:\s*(.*)$/m)?.[1];
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!type || !data || stopped || own !== generation) continue;
          delay = 500;
          await onEvent(type, JSON.parse(data));
        }
      }
    } catch (error) {
      if (stopped || own !== generation || abort.signal.aborted) return;
      if (onDisconnect?.(error) === false || error.message === "unauthorized") { stopped = true; return; }
      timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 5000);
    } finally { await reader?.cancel().catch(() => {}); }
  }
  void connect();
  return {
    stop() { stopped = true; generation++; clearTimeout(timer); controller?.abort(); },
    reconnect() { if (!stopped) void connect(); },
  };
}
