import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderReadme } from "./render-readme.ts";

// STEP 0: just enough of a server to replace the placeholder container and
// keep the two fixed invariants (spec/invariants.test.ts) green. Game state,
// persistence and the WS pipe land in later steps.

const port = Number(process.env.PORT ?? 8080);
const cwd = process.cwd();

const clientIndex = readFileSync(path.join(cwd, "src", "client", "index.html"), "utf8");

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/readme/" || url === "/readme") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReadme(cwd));
    return;
  }

  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(clientIndex);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`listening on :${port}`);
});
