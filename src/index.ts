const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mpp.ninja</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #090d12; color: #d9fbe8; }
    main { width: min(42rem, calc(100% - 3rem)); }
    h1 { margin: 0 0 .75rem; font-size: clamp(2.5rem, 10vw, 5rem); letter-spacing: -.08em; }
    p { color: #91a99c; line-height: 1.6; }
    .status { display: inline-flex; align-items: center; gap: .5rem; color: #7fffb2; }
    .status::before { content: ""; width: .6rem; height: .6rem; border-radius: 50%; background: currentColor; box-shadow: 0 0 1rem currentColor; }
  </style>
</head>
<body>
  <main>
    <p class="status">Hello, world.</p>
    <h1>mpp.ninja</h1>
    <p>A security-aware MPP observatory is taking shape here. MPP functionality is not enabled yet.</p>
  </main>
</body>
</html>`;

function response(body: string | null, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(body, { ...init, headers });
}

function handleRequest(request: Request): Response {
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return response("Method Not Allowed\n", {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  if (url.pathname !== "/") {
    return response("Not Found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return response(request.method === "HEAD" ? null : PAGE, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export default {
  fetch(request): Response {
    return handleRequest(request);
  },
} satisfies ExportedHandler<Env>;
