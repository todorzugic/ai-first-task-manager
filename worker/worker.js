export default {
  async fetch(request) {
    const inUrl = new URL(request.url);

    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(
        JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or POST" } }),
        { status: 405, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
      );
    }

    const GAS_EXEC =
      "https://script.google.com/macros/s/AKfycbziYi7jenBAjMl-DqAHMP9lH1PIoUbK8YJdpFJS5AMFiz2T19lZWYYbIr2VN7LarOwJ/exec";

    const outUrl = new URL(GAS_EXEC);
    outUrl.searchParams.set("format", "json");
    const pathname = inUrl.pathname;
    const verb = request.method.toUpperCase();

    // /health -> path=/health&method=GET
    if (pathname === "/health" && verb === "GET") {
      outUrl.searchParams.set("path", "/health");
      outUrl.searchParams.set("method", "GET");
    }
    // /tasks/next -> path=/tasks/next&method=GET
    else if (pathname === "/tasks/next" && verb === "GET") {
      outUrl.searchParams.set("path", "/tasks/next");
      outUrl.searchParams.set("method", "GET");
    }
    // /tasks (GET list or POST create)
    else if (pathname === "/tasks" && (verb === "GET" || verb === "POST")) {
      outUrl.searchParams.set("path", "/tasks");
      outUrl.searchParams.set("method", verb);
    }
    // /tasks/{id}/complete
    else if (pathname.match(/^\/tasks\/[^\/]+\/complete$/) && verb === "POST") {
      const taskId = pathname.split("/")[2];
      outUrl.searchParams.set("path", `/tasks/${taskId}/complete`);
      outUrl.searchParams.set("method", "POST");
    }
    // /tasks/{id}/snooze
    else if (pathname.match(/^\/tasks\/[^\/]+\/snooze$/) && verb === "POST") {
      const taskId = pathname.split("/")[2];
      outUrl.searchParams.set("path", `/tasks/${taskId}/snooze`);
      outUrl.searchParams.set("method", "POST");
    }
    // Fallback
    else {
      inUrl.searchParams.forEach((v, k) => outUrl.searchParams.set(k, v));
      if (!outUrl.searchParams.get("path")) outUrl.searchParams.set("path", "/");
      if (!outUrl.searchParams.get("method")) outUrl.searchParams.set("method", verb);
    }

    // Forward query params for listTasks filters, now, etc.
    inUrl.searchParams.forEach((v, k) => {
      if (k === "path" || k === "method" || k === "format") return;
      outUrl.searchParams.set(k, v);
    });

    outUrl.searchParams.set("_ts", Date.now().toString());

    const body = verb === "POST" ? await request.text() : undefined;

    let upstream;
    try {
      upstream = await fetch(outUrl.toString(), {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: body || "",
        redirect: "follow",
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: { code: "UPSTREAM_FETCH_FAILED", message: String(e?.message || e) } }),
        { status: 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
      );
    }

    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") || "";
    const trimmed = text.trim();
    const looksJson = ct.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[");

    if (!looksJson) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "UPSTREAM_NOT_JSON",
            message: "Upstream returned non-JSON (Google interstitial/redirect).",
            details: { status: upstream.status, contentType: ct, sample: trimmed.slice(0, 240) },
          },
        }),
        { status: 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
      );
    }

    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  },
};
