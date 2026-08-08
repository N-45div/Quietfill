// Public edge for the Render deployment: listens on Render's $PORT, adds the
// CORS headers the browser app needs, and forwards everything to the
// tee-proxy's external API on localhost. Node-only so the image needs no
// extra reverse-proxy binary.
const http = require("http");

const PORT = Number(process.env.PORT ?? 10000);
const UPSTREAM = { host: "127.0.0.1", port: 6664 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const upstream = http.request(
      {
        ...UPSTREAM,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, ...CORS });
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { ...CORS, "content-type": "text/plain" });
      res.end("tee-proxy upstream unavailable");
    });
    req.pipe(upstream);
  })
  .listen(PORT, () => console.log(`edge listening on :${PORT} -> :${UPSTREAM.port}`));
